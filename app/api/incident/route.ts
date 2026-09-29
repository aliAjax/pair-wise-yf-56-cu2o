import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { parseRole } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** 读取作战室视图。角色来自 x-role 请求头，敏感内容在服务端按角色裁剪，不下发给无权角色。 */
export async function GET(request: NextRequest) {
  const role = parseRole(request.headers.get('x-role')) ?? 'viewer';
  return NextResponse.json(getStore().getView(role));
}
