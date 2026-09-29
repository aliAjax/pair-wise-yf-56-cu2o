import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { handleStoreError, jsonError, parseRole } from '@/lib/server/http';

/** 执行处置动作（服务端校验双人确认等规则）。请求体：{ role, expectedVersion? } */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body?.role);
    if (!role) return jsonError(400, '缺少有效角色', 'bad_role');
    const expectedVersion = typeof body?.expectedVersion === 'number' ? body.expectedVersion : undefined;
    const result = getStore().execute(role, id, expectedVersion);
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return handleStoreError(error);
  }
}
