import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_INCIDENT_ID,
  canReadSensitive,
  type ActionKind,
  type ActionStatus,
  type ActionView,
  type IncidentStatus,
  type IncidentView,
  type Role,
  type Severity,
  type SubIncidentView,
  type TimelineEventView
} from '@/lib/types';

/**
 * 服务端权威存储（单机文件实现）。
 *
 * 不变量：
 * - 所有变更在一个进程内互斥锁内完成，读盘 → 判定 → 写状态 + 追加审计是一个临界区。
 * - 时间线（audit.ndjson）只能 append：模块里没有任何改写/删除历史条目的代码路径。
 * - 动作审批走 version 乐观锁：客户端持有的版本过期即 409，原子确认只记一次。
 * - 敏感动作和敏感记录在服务端就被裁剪，永远不会下发给无权角色。
 */

export interface AuditEvent {
  id: string;
  seq: number;
  incidentId: string;
  at: string;
  actor: string;
  text: string;
  kind: 'system' | 'monitor' | 'sub' | 'approval' | 'execution' | 'migration';
  sensitive?: boolean;
  legacy?: boolean;
}

export interface StoredAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: Role[];
  status: ActionStatus;
  sensitive: boolean;
  version: number;
}

interface StoredIncident {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  affected: string[];
  subIncidents: SubIncidentView[];
  actions: StoredAction[];
  // actionId 的服务端权威顺序，reorder 只改这里、不碰动作版本号
  order: string[];
}

interface PersistedState {
  incident: StoredIncident | null;
  seq: number;
}

export interface LegacyTimelineEvent {
  id?: unknown;
  at?: unknown;
  actor?: unknown;
  text?: unknown;
  sensitive?: unknown;
}

export interface LegacyAction {
  id?: unknown;
  title?: unknown;
  kind?: unknown;
  approvals?: unknown;
  status?: unknown;
  sensitive?: unknown;
}

export interface LegacySubIncident {
  id?: unknown;
  title?: unknown;
  owner?: unknown;
  status?: unknown;
}

/** 浏览器里旧 Zustand persist 结构中与处置记录有关的部分（由 API 层做过 zod 校验）。 */
export interface LegacyIncident {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  affected: string[];
  subIncidents: LegacySubIncident[];
  actions: LegacyAction[];
  timeline: LegacyTimelineEvent[];
}

export interface BootstrapResult {
  migrated: boolean;
  legacyCount: number;
  incidentId: string;
}

export interface MutationOutcome {
  ok: true;
  view: IncidentView;
}

export type MutationError =
  | { ok: false; status: 404 | 403; code: 'not_found' | 'forbidden'; message: string }
  | { ok: false; status: 409; code: 'version_conflict' | 'already_executed'; message: string; currentVersion: number }
  | { ok: false; status: 422; code: 'invalid_order'; message: string };

export class StoreError extends Error {
  constructor(public payload: Exclude<MutationError, { ok: true }>) {
    super(payload.message);
  }
}

const DATA_DIR = process.env.WARROOM_DATA_DIR
  ? path.resolve(process.env.WARROOM_DATA_DIR)
  : path.join(process.cwd(), '.data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.ndjson');

const requiredApprovalsFor = (kind: ActionKind): number => (kind === 'isolate' ? 2 : 0);

function defaultIncident(): StoredIncident {
  const now = Date.now();
  return {
    id: ACTIVE_INCIDENT_ID,
    title: '对外网关异常凭证使用',
    severity: 'critical',
    status: 'investigating',
    affected: ['api-gateway', 'customer-portal', 'audit-log'],
    subIncidents: [
      { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
      { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
    ],
    actions: [
      { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['analyst'], status: 'pending', sensitive: true, version: 0 },
      { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending', sensitive: false, version: 0 },
      { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true, version: 0 }
    ],
    order: ['act-1', 'act-2', 'act-3']
  };
}

function seedAudit(incidentId: string): Omit<AuditEvent, 'seq'>[] {
  const now = Date.now();
  return [
    { id: 'e1', incidentId, at: new Date(now - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', kind: 'system', sensitive: true },
    { id: 'e2', incidentId, at: new Date(now - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口', kind: 'system' }
  ];
}

// ---------- 底层读写 ----------

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readState(): PersistedState {
  if (!existsSync(STATE_FILE)) return { incident: null, seq: 0 };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState;
    return { incident: parsed.incident ?? null, seq: parsed.seq ?? 0 };
  } catch {
    // 状态文件损坏时不允许静默覆盖审计：交由运维处置
    throw new Error(`权威状态文件无法解析：${STATE_FILE}`);
  }
}

function writeState(state: PersistedState) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  // 同目录临时文件 + rename，保证状态文件要么是旧内容要么是新内容
  writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: 'w' });
  renameSync(tmp, STATE_FILE);
}

/** 审计文件是只追加的；返回追加后的完整事件。 */
function appendAudit(event: Omit<AuditEvent, 'seq'>, seq: number): AuditEvent {
  ensureDir();
  const full: AuditEvent = { ...event, seq };
  appendFileSync(AUDIT_FILE, `${JSON.stringify(full)}\n`, { flag: 'a' });
  return full;
}

function readAudit(incidentId: string): AuditEvent[] {
  if (!existsSync(AUDIT_FILE)) return [];
  const events: AuditEvent[] = [];
  for (const line of readFileSync(AUDIT_FILE, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = JSON.parse(trimmed) as AuditEvent;
    if (event.incidentId === incidentId) events.push(event);
  }
  return events.sort((a, b) => b.seq - a.seq);
}

// ---------- 互斥锁：所有变更串行化 ----------

let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => T): Promise<T> {
  const next = chain.then(fn, fn);
  // 无论本次成败，锁都要释放给后续任务
  chain = next.then(() => undefined, () => undefined);
  return next;
}

let clockSeq = 0;
function uniqueId(prefix: string): string {
  clockSeq = (clockSeq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${clockSeq.toString(36)}`;
}

// ---------- 引导 / 迁移 ----------

/**
 * 首次接入：浏览器上报老记录（可空）。
 * - 第一个调用决定服务端事实源：有老记录就迁移，没有就用系统初始剧本。
 * - 老记录里的 approvals、sensitive、status 语义保持不变，逐条打上 legacy 标记进审计。
 * - 已经引导过的并发/重复调用直接返回 migrated:false，绝不覆盖。
 */
export function bootstrap(legacy: LegacyIncident | null): Promise<BootstrapResult> {
  return withLock(() => {
    const state = readState();
    if (state.incident) {
      return { migrated: false, legacyCount: 0, incidentId: state.incident.id };
    }
    ensureDir();
    let incident: StoredIncident;
    let importedEvents: Omit<AuditEvent, 'seq'>[] = [];
    let seq = 0;

    if (legacy) {
      const actions: StoredAction[] = legacy.actions.map((raw) => ({
        id: String(raw.id),
        title: String(raw.title),
        // 老记录语义照旧：未知类型按 notify 处理
        kind: (['isolate', 'block', 'restore', 'notify'].includes(raw.kind as string) ? raw.kind : 'notify') as ActionKind,
        approvals: Array.isArray(raw.approvals) ? (raw.approvals as Role[]) : [],
        status: (['pending', 'approved', 'executed'].includes(raw.status as string) ? raw.status : 'pending') as ActionStatus,
        sensitive: raw.sensitive === true,
        // 迁移动作作为新版本起点
        version: 0
      }));
      const subIncidents = legacy.subIncidents.map((raw) => ({
        id: String(raw.id),
        title: String(raw.title),
        owner: String(raw.owner),
        status: (['open', 'contained', 'closed'].includes(raw.status as string) ? raw.status : 'open') as SubIncidentView['status']
      }));
      incident = {
        id: legacy.id || ACTIVE_INCIDENT_ID,
        title: legacy.title,
        severity: legacy.severity,
        status: legacy.status,
        affected: legacy.affected,
        subIncidents,
        actions,
        order: actions.map((item) => item.id)
      };
      // 老时间线按时间正序写入只追加审计，语义不变
      importedEvents = legacy.timeline
        .map((raw) => ({
          id: String(raw.id ?? uniqueId('e')),
          incidentId: incident.id,
          at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
          actor: String(raw.actor ?? '值班同事'),
          text: String(raw.text ?? ''),
          kind: 'system' as const,
          sensitive: raw.sensitive === true ? true : undefined,
          legacy: true as const
        }))
        .sort((a, b) => a.at.localeCompare(b.at));
    } else {
      incident = defaultIncident();
      importedEvents = seedAudit(incident.id);
    }

    for (const event of importedEvents) {
      seq += 1;
      appendAudit(event, seq);
    }
    if (legacy) {
      seq += 1;
      appendAudit(
        {
          id: uniqueId('e'),
          incidentId: incident.id,
          at: new Date().toISOString(),
          actor: '系统',
          text: `浏览器本地处置记录已迁移到服务端审计，共导入 ${importedEvents.filter((e) => e.legacy).length} 条历史时间线，旧审批与敏感标记语义保持不变`,
          kind: 'migration'
        },
        seq
      );
    }
    writeState({ incident, seq });
    return { migrated: Boolean(legacy), legacyCount: importedEvents.filter((e) => e.legacy).length, incidentId: incident.id };
  });
}

// ---------- 视图投影（按角色裁剪） ----------

function projectView(incident: StoredIncident, audit: AuditEvent[], role: Role): IncidentView {
  const seeSensitive = canReadSensitive(role);

  let redactedActions = 0;
  const ordered = incident.order
    .map((id) => incident.actions.find((action) => action.id === id))
    .filter((action): action is StoredAction => Boolean(action));
  // order 之外（理论上不会有）的动作兜底排到末尾
  for (const action of incident.actions) if (!incident.order.includes(action.id)) ordered.push(action);

  const actions: ActionView[] = [];
  for (const action of ordered) {
    // 敏感动作直接不下发，而不是下发后遮蔽——无权角色拿不到标题/审批等任何字段
    if (action.sensitive && !seeSensitive) {
      redactedActions += 1;
      continue;
    }
    const required = requiredApprovalsFor(action.kind);
    actions.push({
      id: action.id,
      title: action.title,
      kind: action.kind,
      status: action.status,
      approvals: action.approvals,
      version: action.version,
      sensitive: action.sensitive,
      requiredApprovals: required,
      canApprove: role !== 'viewer' && action.status === 'pending' && !action.approvals.includes(role),
      canExecute:
        role !== 'viewer' && action.status !== 'executed' && (required === 0 || action.approvals.length >= required)
    });
  }

  let redactedTimeline = 0;
  const timeline: TimelineEventView[] = [];
  for (const event of audit) {
    if (event.sensitive && !seeSensitive) {
      redactedTimeline += 1;
      continue;
    }
    timeline.push({
      id: event.id,
      at: event.at,
      actor: event.actor,
      text: event.text,
      sensitive: event.sensitive,
      legacy: event.legacy
    });
  }

  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    affected: incident.affected,
    subIncidents: incident.subIncidents,
    actions,
    timeline,
    redacted: { actions: redactedActions, timelineEvents: redactedTimeline },
    // 只能看到全部动作的角色才能给出合法的新顺序
    reorderable: seeSensitive,
    serverTime: new Date().toISOString()
  };
}

// ---------- 变更原语 ----------

function commit(state: PersistedState): void {
  writeState(state);
}

function appendAndTouch(state: PersistedState, event: Omit<AuditEvent, 'seq' | 'incidentId'>): AuditEvent {
  state.seq += 1;
  return appendAudit({ ...event, incidentId: state.incident!.id }, state.seq);
}

const MONITOR_MIN_GAP_MS = 20_000;

/** 所有值班同事共享同一条监测心跳：距上一条超过 20 秒才由下一次轮询生成。 */
function maybeMonitorTick(state: PersistedState, audit: AuditEvent[]): boolean {
  if (!state.incident) return false;
  const lastMonitor = audit.find((event) => event.kind === 'monitor');
  const now = Date.now();
  if (lastMonitor && now - new Date(lastMonitor.at).getTime() < MONITOR_MIN_GAP_MS) return false;
  appendAndTouch(state, {
    id: uniqueId('e'),
    at: new Date(now).toISOString(),
    actor: '监测代理',
    text: `实时检查：${state.incident.affected.length} 项资产状态已更新`,
    kind: 'monitor'
  });
  return true;
}

/**
 * 原子审批：
 * - 同一角色重复确认 → 幂等成功，不重复追加审计、不重复计数。
 * - expectedVersion 与服务端不一致（两个人几乎同时点，后到的请求）→ 409，什么都不写。
 */
export async function approveAction(input: {
  actionId: string;
  role: Role;
  expectedVersion: number;
}): Promise<MutationOutcome> {
  return withLock(() => {
    const state = readState();
    if (!state.incident) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '事件不存在' });
    if (input.role === 'viewer') {
      throw new StoreError({ ok: false, status: 403, code: 'forbidden', message: '访客角色无权审批' });
    }
    const action = state.incident.actions.find((item) => item.id === input.actionId);
    if (!action) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '处置动作不存在' });

    // 重复确认只记一次：先判幂等，哪怕客户端拿的是旧版本
    if (action.approvals.includes(input.role)) {
      const audit = readAudit(state.incident.id);
      return { ok: true, view: projectView(state.incident, audit, input.role) };
    }
    if (action.status === 'executed') {
      throw new StoreError({
        ok: false,
        status: 409,
        code: 'already_executed',
        message: '动作已执行，不能再审批',
        currentVersion: action.version
      });
    }
    if (action.version !== input.expectedVersion) {
      throw new StoreError({
        ok: false,
        status: 409,
        code: 'version_conflict',
        message: '动作已被其他值班同事更新，请刷新后基于最新版本确认',
        currentVersion: action.version
      });
    }

    const nextApprovals = [...action.approvals, input.role];
    const required = requiredApprovalsFor(action.kind);
    const nextStatus: ActionStatus =
      action.status === 'approved' || (required > 0 && nextApprovals.length >= required) ? 'approved' : action.status;
    state.incident.actions = state.incident.actions.map((item) =>
      item.id === action.id ? { ...item, approvals: nextApprovals, status: nextStatus, version: item.version + 1 } : item
    );
    appendAndTouch(state, {
      id: uniqueId('e'),
      at: new Date().toISOString(),
      actor: input.role,
      text: `审批处置动作：${action.title}（${nextApprovals.length}/${Math.max(required, 1)}）`,
      kind: 'approval',
      sensitive: action.sensitive ? true : undefined
    });
    commit(state);
    const audit = readAudit(state.incident.id);
    return { ok: true, view: projectView(state.incident, audit, input.role) };
  });
}

export async function executeAction(input: {
  actionId: string;
  role: Role;
  expectedVersion: number;
}): Promise<MutationOutcome> {
  return withLock(() => {
    const state = readState();
    if (!state.incident) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '事件不存在' });
    if (input.role === 'viewer') {
      throw new StoreError({ ok: false, status: 403, code: 'forbidden', message: '访客角色无权执行' });
    }
    const action = state.incident.actions.find((item) => item.id === input.actionId);
    if (!action) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '处置动作不存在' });

    // 版本优先：拿着旧版本到达的并发点击（另一个人几乎同时执行）一律 409，
    // 只有带着当前版本的重复执行才走幂等分支
    if (action.version !== input.expectedVersion) {
      if (action.status === 'executed') {
        const audit = readAudit(state.incident.id);
        return { ok: true, view: projectView(state.incident, audit, input.role) };
      }
      throw new StoreError({
        ok: false,
        status: 409,
        code: 'version_conflict',
        message: '动作已被其他值班同事更新，请刷新后基于最新版本执行',
        currentVersion: action.version
      });
    }
    if (action.status === 'executed') {
      // 同版本重复执行幂等：返回当前视图即可，不追加第二条执行记录
      const audit = readAudit(state.incident.id);
      return { ok: true, view: projectView(state.incident, audit, input.role) };
    }
    const required = requiredApprovalsFor(action.kind);
    if (required > 0 && action.approvals.length < required) {
      throw new StoreError({
        ok: false,
        status: 403,
        code: 'forbidden',
        message: `隔离动作需要 ${required} 名不同角色确认后才能执行`
      });
    }

    state.incident.actions = state.incident.actions.map((item) =>
      item.id === action.id ? { ...item, status: 'executed', version: item.version + 1 } : item
    );
    appendAndTouch(state, {
      id: uniqueId('e'),
      at: new Date().toISOString(),
      actor: input.role,
      text: `执行处置动作：${action.title}`,
      kind: 'execution',
      sensitive: action.sensitive ? true : undefined
    });
    commit(state);
    const audit = readAudit(state.incident.id);
    return { ok: true, view: projectView(state.incident, audit, input.role) };
  });
}

export async function addSubIncident(input: { title: string; owner: string; role: Role }): Promise<MutationOutcome> {
  return withLock(() => {
    const state = readState();
    if (!state.incident) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '事件不存在' });
    if (input.role === 'viewer') {
      throw new StoreError({ ok: false, status: 403, code: 'forbidden', message: '访客角色无权创建子事件' });
    }
    const sub = { id: uniqueId('sub'), title: input.title, owner: input.owner, status: 'open' as const };
    state.incident.subIncidents = [...state.incident.subIncidents, sub];
    appendAndTouch(state, {
      id: uniqueId('e'),
      at: new Date().toISOString(),
      actor: '响应负责人',
      text: `创建子事件：${input.title}`,
      kind: 'sub'
    });
    commit(state);
    const audit = readAudit(state.incident.id);
    return { ok: true, view: projectView(state.incident, audit, input.role) };
  });
}

/** 调整优先级：只接受「服务端下发全集」的重排，少一个 id 都判定非法，防止裁剪后重排泄露/丢动作。 */
export async function reorderActions(input: { orderedIds: string[]; role: Role }): Promise<MutationOutcome> {
  return withLock(() => {
    const state = readState();
    if (!state.incident) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '事件不存在' });
    if (!canReadSensitive(input.role)) {
      throw new StoreError({ ok: false, status: 403, code: 'forbidden', message: '当前角色看到的动作已被裁剪，不能调整顺序' });
    }
    const current = state.incident.actions.map((item) => item.id);
    const sameSet =
      input.orderedIds.length === current.length && input.orderedIds.every((id) => current.includes(id));
    if (!sameSet) {
      throw new StoreError({
        ok: false,
        status: 422,
        code: 'invalid_order',
        message: '排序提交的动作集合与服务端不一致，请刷新后重试'
      });
    }
    state.incident.order = input.orderedIds;
    commit(state);
    const audit = readAudit(state.incident.id);
    return { ok: true, view: projectView(state.incident, audit, input.role) };
  });
}

/** 轮询附带：拉视图时顺带按节流生成共享监测心跳。 */
export async function pollView(role: Role): Promise<IncidentView> {
  return withLock(() => {
    const state = readState();
    if (!state.incident) throw new StoreError({ ok: false, status: 404, code: 'not_found', message: '事件尚未初始化，请先完成引导' });
    let audit = readAudit(state.incident.id);
    if (maybeMonitorTick(state, audit)) commit(state);
    audit = readAudit(state.incident.id);
    return projectView(state.incident, audit, role);
  });
}
