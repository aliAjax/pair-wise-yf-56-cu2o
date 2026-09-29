import type { IncidentView, Role } from './types';

export class ApiConflictError extends Error {
  constructor(
    public code: 'version_conflict' | 'already_executed',
    message: string,
    public currentVersion: number
  ) {
    super(message);
  }
}

export class ApiForbiddenError extends Error {}

interface MutationEnvelope {
  ok: boolean;
  view?: IncidentView;
  code?: string;
  message?: string;
  currentVersion?: number;
}

async function send<T>(url: string, init: RequestInit, role: Role): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-role': role, ...(init.headers ?? {}) }
  });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const envelope = body as MutationEnvelope | null;
    if (response.status === 409 && (envelope?.code === 'version_conflict' || envelope?.code === 'already_executed')) {
      throw new ApiConflictError(envelope.code, envelope.message ?? '动作版本冲突', envelope.currentVersion ?? 0);
    }
    if (response.status === 403) throw new ApiForbiddenError(envelope?.message ?? '当前角色无权操作');
    throw new Error(envelope?.message ?? `请求失败（${response.status}）`);
  }
  return body as T;
}

export interface BootstrapResponse {
  ok: boolean;
  migrated: boolean;
  legacyCount: number;
  incidentId: string;
}

export function bootstrap(legacy: unknown, role: Role) {
  return send<BootstrapResponse>('/api/bootstrap', { method: 'POST', body: JSON.stringify({ legacy }) }, role);
}

export function fetchIncident(role: Role) {
  return send<IncidentView>('/api/incident', { method: 'GET', headers: { 'x-role': role } }, role);
}

export function approveAction(actionId: string, expectedVersion: number, role: Role) {
  return send<MutationEnvelope>(
    `/api/actions/${encodeURIComponent(actionId)}/approve`,
    { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    role
  );
}

export function executeAction(actionId: string, expectedVersion: number, role: Role) {
  return send<MutationEnvelope>(
    `/api/actions/${encodeURIComponent(actionId)}/execute`,
    { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    role
  );
}

export function createSubIncident(payload: { title: string; owner: string }, role: Role) {
  return send<MutationEnvelope>('/api/sub-incidents', { method: 'POST', body: JSON.stringify(payload) }, role);
}

export function reorderActions(orderedIds: string[], role: Role) {
  return send<MutationEnvelope>('/api/actions/reorder', { method: 'POST', body: JSON.stringify({ orderedIds }) }, role);
}
