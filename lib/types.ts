// 客户端与服务端共享的领域类型。服务端才是唯一事实源，这里只放视图模型。

export const ACTIVE_INCIDENT_ID = 'INC-2026-0929';

export const ROLES = ['analyst', 'responder', 'legal', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const roleNames: Record<Role, string> = {
  analyst: '分析员',
  responder: '响应负责人',
  legal: '法务/公关',
  viewer: '访客'
};

// 只有响应负责人和法务/公关能看到敏感动作与敏感处置记录
export const SENSITIVE_ROLES: readonly Role[] = ['responder', 'legal'];
export function canReadSensitive(role: Role): boolean {
  return SENSITIVE_ROLES.includes(role);
}

export type Severity = 'medium' | 'high' | 'critical';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';
export type SubIncidentStatus = 'open' | 'contained' | 'closed';
export type IncidentStatus = 'investigating' | 'contained' | 'recovered';

export interface SubIncidentView {
  id: string;
  title: string;
  owner: string;
  status: SubIncidentStatus;
}

export interface ActionView {
  id: string;
  title: string;
  kind: ActionKind;
  status: ActionStatus;
  approvals: Role[];
  // 乐观锁版本号：每次审批/执行成功后服务端递增，客户端确认时必须回传
  version: number;
  sensitive: boolean;
  canApprove: boolean;
  canExecute: boolean;
  // 隔离动作需两名不同角色确认，其余动作沿用旧规则不强制审批
  requiredApprovals: number;
}

export interface TimelineEventView {
  id: string;
  at: string;
  actor: string;
  text: string;
  sensitive?: boolean;
  // 来自浏览器历史记录迁移的条目
  legacy?: boolean;
}

export interface IncidentView {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  affected: string[];
  subIncidents: SubIncidentView[];
  actions: ActionView[];
  timeline: TimelineEventView[];
  // 服务端按角色裁剪掉的条数，供界面提示「有内容被裁剪」
  redacted: { actions: number; timelineEvents: number };
  // 只有能看全部动作的角色才允许调整顺序，否则拖拽控件不下发
  reorderable: boolean;
  serverTime: string;
}
