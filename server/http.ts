import { NextResponse } from 'next/server';
import { ROLES, type Role } from '@/lib/types';
import { StoreError } from './store';

/** 角色由请求头带入（演示环境的角色切换），非法值一律按最小权限 viewer 处理。 */
export function getRole(request: Request): Role {
  const value = request.headers.get('x-role');
  return (ROLES as readonly string[]).includes(value ?? '') ? (value as Role) : 'viewer';
}

export function jsonOk(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function handleError(error: unknown): NextResponse {
  if (error instanceof StoreError) {
    return NextResponse.json(error.payload, { status: error.payload.status });
  }
  console.error('[warroom] unhandled server error', error);
  return NextResponse.json({ ok: false, code: 'internal_error', message: '服务端内部错误' }, { status: 500 });
}
