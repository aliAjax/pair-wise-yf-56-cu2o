import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { handleStoreError, jsonError, parseRole } from '@/lib/server/http';

/** 调整处置动作优先级顺序。请求体：{ role, activeId, overId } */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body?.role);
    if (!role) return jsonError(400, '缺少有效角色', 'bad_role');
    if (typeof body?.activeId !== 'string' || typeof body?.overId !== 'string') {
      return jsonError(400, '缺少 activeId / overId', 'bad_request');
    }
    return NextResponse.json(getStore().reorder(role, body.activeId, body.overId));
  } catch (error) {
    return handleStoreError(error);
  }
}
