import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, IncidentView, ResponseAction, Role, Severity, SubIncident } from '@/lib/types';

/**
 * 服务端作战室状态：唯一事实源。
 *
 * - 所有变更函数都是同步的，在 Node 单线程模型下“校验版本号 + 落变更”
 *   发生在同一个同步代码块里，天然原子，并发确认不会产生交错写。
 * - 审计时间线只追加：条目写入即冻结，模块不暴露任何修改/删除入口，
 *   同时逐行追加到 data/audit-log.jsonl，重启后按审计文件恢复。
 * - 敏感内容只在 getView() 出口处按角色裁剪，绝不进入未授权角色的响应体。
 */

const SENSITIVE_ROLES: readonly Role[] = ['responder', 'legal'];
const ROLE_NAMES: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const STATUS_RANK: Record<ResponseAction['status'], number> = { pending: 0, approved: 1, executed: 2 };
const TICK_MS = 20000;

interface IncidentCore {
  id: string;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
}

interface StoreState {
  incident: IncidentCore;
  audit: AuditEvent[];
  seq: number;
  migrationApplied: boolean;
}

export class StoreError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

const DATA_DIR = path.join(process.cwd(), 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit-log.jsonl');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'state-snapshot.json');

function seed(): StoreState {
  const now = Date.now();
  return {
    incident: {
      id: 'INC-2026-0929',
      title: '对外网关异常凭证使用',
      severity: 'critical',
      status: 'investigating',
      affected: ['api-gateway', 'customer-portal', 'audit-log'],
      subIncidents: [
        { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
        { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
      ],
      actions: [
        { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['analyst'], status: 'pending', sensitive: true, version: 1 },
        { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending', version: 1 },
        { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true, version: 1 }
      ]
    },
    audit: [
      { seq: 1, id: 'e1', at: new Date(now - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
      { seq: 2, id: 'e2', at: new Date(now - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
    ],
    seq: 2,
    migrationApplied: false
  };
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function loadState(): StoreState {
  const snapshot = readJsonFile<StoreState>(SNAPSHOT_FILE);
  let auditFromFile: AuditEvent[] = [];
  try {
    auditFromFile = fs
      .readFileSync(AUDIT_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    auditFromFile = [];
  }
  if (snapshot) {
    const audit = auditFromFile.length > 0 ? auditFromFile : snapshot.audit ?? [];
    const maxSeq = audit.reduce((max, event) => Math.max(max, event.seq), 0);
    return { ...snapshot, audit, seq: Math.max(snapshot.seq ?? 0, maxSeq) };
  }
  if (auditFromFile.length > 0) {
    const base = seed();
    return { ...base, audit: auditFromFile, seq: auditFromFile[auditFromFile.length - 1].seq };
  }
  return seed();
}

function persistSnapshot(state: StoreState) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(state));
  } catch (error) {
    console.warn('[war-room] 快照写入失败（仅内存态继续）', error);
  }
}

function persistAuditLine(event: AuditEvent) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(event)}\n`);
  } catch (error) {
    console.warn('[war-room] 审计日志追加失败（仅内存态继续）', error);
  }
}

function createStore() {
  const state = loadState();

  /** 审计日志唯一入口：只追加，写入即冻结，任何人都无法改写已记录的处置经过。 */
  function appendAudit(entry: Omit<AuditEvent, 'seq'> & { seq?: number }): AuditEvent {
    const seq = entry.seq ?? state.seq + 1;
    const frozen = Object.freeze({ ...entry, seq });
    state.audit.push(frozen);
    state.seq = Math.max(state.seq, seq);
    persistAuditLine(frozen);
    persistSnapshot(state);
    return frozen;
  }

  function canSeeSensitive(role: Role) {
    return SENSITIVE_ROLES.includes(role);
  }

  function findActionForRole(role: Role, id: string): ResponseAction {
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || (action.sensitive && !canSeeSensitive(role))) {
      throw new StoreError(404, '处置动作不存在或当前角色不可见', 'action_not_found');
    }
    return action;
  }

  function requireOperator(role: Role) {
    if (role === 'viewer') throw new StoreError(403, '访客角色为只读，不能执行处置操作', 'forbidden');
  }

  function assertVersion(action: ResponseAction, expectedVersion?: number) {
    if (expectedVersion !== undefined && action.version !== expectedVersion) {
      throw new StoreError(409, '动作版本已变化，请刷新后重试', 'version_conflict', { currentVersion: action.version });
    }
  }

  const store = {
    /** 按角色裁剪后的视图：敏感动作与敏感审计记录不下发给无权角色。 */
    getView(role: Role): IncidentView {
      const allowSensitive = canSeeSensitive(role);
      const timeline = state.audit
        .filter((event) => allowSensitive || !event.sensitive)
        .slice()
        .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1));
      return {
        ...state.incident,
        subIncidents: state.incident.subIncidents.map((item) => ({ ...item })),
        actions: state.incident.actions.filter((action) => allowSensitive || !action.sensitive).map((action) => ({ ...action, approvals: [...action.approvals] })),
        timeline,
        role,
        canSeeSensitive: allowSensitive,
        migrationApplied: state.migrationApplied,
        serverTime: new Date().toISOString()
      };
    },

    addSubIncident(role: Role, payload: { title: string; owner: string }) {
      requireOperator(role);
      const sub: SubIncident = { id: `sub-${Date.now()}`, title: payload.title, owner: payload.owner, status: 'open' };
      state.incident.subIncidents.push(sub);
      appendAudit({ id: `e-${Date.now()}-sub`, at: new Date().toISOString(), actor: ROLE_NAMES[role], text: `创建子事件：${payload.title}` });
      persistSnapshot(state);
      return sub;
    },

    /**
     * 审批（服务端判定）。同一角色重复确认幂等只记一次；
     * 不同角色并发确认按版本号 CAS，冲突方拿到 409 后刷新重试。
     */
    approve(role: Role, id: string, expectedVersion?: number) {
      requireOperator(role);
      const action = findActionForRole(role, id);
      if (action.status === 'executed') throw new StoreError(409, '动作已执行，不能再审批', 'already_executed');
      if (action.approvals.includes(role)) {
        return { action: { ...action }, deduplicated: true };
      }
      assertVersion(action, expectedVersion);
      action.approvals = [...action.approvals, role];
      if (action.kind === 'isolate' && action.approvals.length >= 2) action.status = 'approved';
      action.version += 1;
      appendAudit({ id: `e-${Date.now()}-ap-${role}`, at: new Date().toISOString(), actor: ROLE_NAMES[role], text: `审批处置动作：${action.title}`, sensitive: action.sensitive });
      persistSnapshot(state);
      return { action: { ...action }, deduplicated: false };
    },

    execute(role: Role, id: string, expectedVersion?: number) {
      requireOperator(role);
      const action = findActionForRole(role, id);
      if (action.status === 'executed') {
        return { action: { ...action }, deduplicated: true };
      }
      if (action.kind === 'isolate' && action.approvals.length < 2) {
        throw new StoreError(409, '隔离动作需两名不同角色确认后才能执行', 'needs_dual_approval');
      }
      assertVersion(action, expectedVersion);
      action.status = 'executed';
      action.version += 1;
      appendAudit({ id: `e-${Date.now()}-ex-${role}`, at: new Date().toISOString(), actor: ROLE_NAMES[role], text: `执行处置动作：${action.title}`, sensitive: action.sensitive });
      persistSnapshot(state);
      return { action: { ...action }, deduplicated: false };
    },

    reorder(role: Role, activeId: string, overId: string) {
      requireOperator(role);
      findActionForRole(role, activeId);
      findActionForRole(role, overId);
      const actions = state.incident.actions;
      const from = actions.findIndex((item) => item.id === activeId);
      const to = actions.findIndex((item) => item.id === overId);
      if (from < 0 || to < 0 || from === to) return { ok: true };
      const [moved] = actions.splice(from, 1);
      actions.splice(to, 0, moved);
      persistSnapshot(state);
      return { ok: true };
    },

    /**
     * 浏览器本地记录迁移：审批记录与敏感标记含义照旧。
     * 全部按 id 幂等合并，重复提交不会产生重复数据。
     */
    migrate(legacy: {
      subIncidents?: Array<{ id: string; title?: string; owner?: string; status?: SubIncident['status'] }>;
      actions?: Array<{ id: string; title?: string; kind?: ResponseAction['kind']; approvals?: string[]; status?: ResponseAction['status']; sensitive?: boolean }>;
      timeline?: Array<{ id: string; at?: string; actor?: string; text?: string; sensitive?: boolean }>;
    }) {
      let mergedActions = 0;
      let mergedSubs = 0;
      let mergedEvents = 0;

      for (const sub of legacy.subIncidents ?? []) {
        if (!sub.id || state.incident.subIncidents.some((item) => item.id === sub.id)) continue;
        state.incident.subIncidents.push({ id: sub.id, title: String(sub.title ?? '未命名子事件'), owner: String(sub.owner ?? '未指定'), status: sub.status ?? 'open' });
        mergedSubs += 1;
      }

      for (const legacyAction of legacy.actions ?? []) {
        if (!legacyAction.id) continue;
        const incoming = (legacyAction.approvals ?? []).filter((role): role is Role => role in ROLE_NAMES);
        const existing = state.incident.actions.find((item) => item.id === legacyAction.id);
        if (!existing) {
          const approvals = [...new Set(incoming)];
          const status: ResponseAction['status'] =
            legacyAction.status === 'approved' || legacyAction.status === 'executed'
              ? legacyAction.status
              : legacyAction.kind === 'isolate' && approvals.length >= 2
                ? 'approved'
                : 'pending';
          state.incident.actions.push({
            id: legacyAction.id,
            title: String(legacyAction.title ?? '未命名动作'),
            kind: legacyAction.kind ?? 'notify',
            approvals,
            status,
            sensitive: legacyAction.sensitive === true ? true : undefined,
            version: 1
          });
          mergedActions += 1;
          continue;
        }
        let changed = false;
        const union = [...existing.approvals];
        for (const role of incoming) {
          if (!union.includes(role)) {
            union.push(role);
            changed = true;
          }
        }
        existing.approvals = union;
        if (legacyAction.status && STATUS_RANK[legacyAction.status] > STATUS_RANK[existing.status]) {
          existing.status = legacyAction.status;
          changed = true;
        }
        if (existing.kind === 'isolate' && existing.approvals.length >= 2 && existing.status === 'pending') {
          existing.status = 'approved';
          changed = true;
        }
        if (legacyAction.sensitive === true && !existing.sensitive) {
          existing.sensitive = true;
          changed = true;
        }
        if (changed) {
          existing.version += 1;
          mergedActions += 1;
        }
      }

      const knownEventIds = new Set(state.audit.map((event) => event.id));
      const legacyEvents = (legacy.timeline ?? [])
        .filter((event) => event.id && event.at && !knownEventIds.has(event.id))
        .sort((a, b) => (a.at! < b.at! ? -1 : 1));
      for (const event of legacyEvents) {
        appendAudit({
          id: event.id!,
          at: event.at!,
          actor: String(event.actor ?? '未知'),
          text: String(event.text ?? ''),
          sensitive: event.sensitive === true ? true : undefined
        });
        mergedEvents += 1;
      }

      if (mergedActions + mergedSubs + mergedEvents > 0) {
        appendAudit({
          id: `e-${Date.now()}-migrate`,
          at: new Date().toISOString(),
          actor: '系统',
          text: `浏览器本地处置记录已迁入服务端：动作 ${mergedActions} 项、子事件 ${mergedSubs} 项、时间线 ${mergedEvents} 条`
        });
      }
      state.migrationApplied = true;
      persistSnapshot(state);
      return { mergedActions, mergedSubs, mergedEvents };
    },

    /** 服务端监测节拍：所有客户端看到同一条审计流。 */
    tick() {
      appendAudit({
        id: `e-${Date.now()}-tick`,
        at: new Date().toISOString(),
        actor: '监测代理',
        text: `实时检查：${state.incident.affected.length} 项资产状态已更新`
      });
    }
  };

  const timer = setInterval(() => store.tick(), TICK_MS);
  timer.unref?.();
  return store;
};

type Store = ReturnType<typeof createStore>;

const globalRef = globalThis as unknown as { __yf56ServerStore?: Store };

export function getStore(): Store {
  if (!globalRef.__yf56ServerStore) {
    globalRef.__yf56ServerStore = createStore();
  }
  return globalRef.__yf56ServerStore;
}
