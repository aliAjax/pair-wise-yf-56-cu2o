import type { IncidentView, Role } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `请求失败（${res.status}）`, body?.code, body?.details);
  }
  return body as T;
}

function post<T>(url: string, payload: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

export const api = {
  getIncident: (role: Role) => request<IncidentView>('/api/incident', { headers: { 'x-role': role } }),
  approve: (id: string, role: Role, expectedVersion: number) =>
    post<{ deduplicated: boolean }>(`/api/incident/actions/${encodeURIComponent(id)}/approve`, { role, expectedVersion }),
  execute: (id: string, role: Role, expectedVersion: number) =>
    post<{ deduplicated: boolean }>(`/api/incident/actions/${encodeURIComponent(id)}/execute`, { role, expectedVersion }),
  reorder: (role: Role, activeId: string, overId: string) => post('/api/incident/actions/reorder', { role, activeId, overId }),
  addSubIncident: (role: Role, payload: { title: string; owner: string }) => post('/api/incident/sub-incidents', { role, ...payload }),
  migrate: (legacy: unknown) => post<{ ok: boolean; mergedActions: number; mergedSubs: number; mergedEvents: number }>('/api/incident/migrate', legacy),
  health: async () => {
    const started = performance.now();
    await request('/api/health');
    return { connected: true, latency: Math.round(performance.now() - started) };
  }
};
