import { NextResponse } from 'next/server';
import type { Role } from '@/lib/types';
import { StoreError } from './store';

const ROLES: readonly Role[] = ['analyst', 'responder', 'legal', 'viewer'];

export function parseRole(value: unknown): Role | null {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

export function jsonError(status: number, message: string, code?: string, details?: unknown) {
  return NextResponse.json({ error: message, code, details }, { status });
}

export function handleStoreError(error: unknown) {
  if (error instanceof StoreError) {
    return jsonError(error.status, error.message, error.code, error.details);
  }
  console.error('[war-room] 未处理的服务端错误', error);
  return jsonError(500, '服务端内部错误', 'internal');
}
