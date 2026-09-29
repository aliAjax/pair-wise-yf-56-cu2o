import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { handleStoreError, jsonError, parseRole } from '@/lib/server/http';

/**
 * 审批处置动作（服务端判定）。
 * 请求体：{ role, expectedVersion? }
 * - 同一角色重复确认：幂等返回，审计只记一次。
 * - 版本号不匹配：409 version_conflict，客户端刷新后按新版本号重试。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body?.role);
    if (!role) return jsonError(400, '缺少有效角色', 'bad_role');
    const expectedVersion = typeof body?.expectedVersion === 'number' ? body.expectedVersion : undefined;
    const result = getStore().approve(role, id, expectedVersion);
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return handleStoreError(error);
  }
}
