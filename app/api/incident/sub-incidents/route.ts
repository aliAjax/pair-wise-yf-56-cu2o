import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/server/store';
import { handleStoreError, jsonError, parseRole } from '@/lib/server/http';

const schema = z.looseObject({
  title: z.string().min(1).max(200),
  owner: z.string().min(1).max(100)
});

/** 创建子事件。请求体：{ role, title, owner } */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const role = parseRole(body?.role);
    if (!role) return jsonError(400, '缺少有效角色', 'bad_role');
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonError(400, '子事件名称或负责组不合法', 'bad_request');
    const sub = getStore().addSubIncident(role, parsed.data);
    return NextResponse.json(sub, { status: 201 });
  } catch (error) {
    return handleStoreError(error);
  }
}
