export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';

export interface AuditEvent {
  seq: number;
  id: string;
  at: string;
  actor: string;
  text: string;
  sensitive?: boolean;
}

export interface SubIncident {
  id: string;
  title: string;
  owner: string;
  status: 'open' | 'contained' | 'closed';
}

export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: Role[];
  status: ActionStatus;
  sensitive?: boolean;
  version: number;
}

export interface IncidentView {
  id: string;
  title: string;
  severity: Severity;
  status: 'investigating' | 'contained' | 'recovered';
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: AuditEvent[];
  role: Role;
  canSeeSensitive: boolean;
  migrationApplied: boolean;
  serverTime: string;
}
