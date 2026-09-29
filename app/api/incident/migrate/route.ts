import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/server/store';
import { handleStoreError, jsonError } from '@/lib/server/http';

/**
 * 浏览器本地处置记录迁移入口。
 * 旧 localStorage 中的审批记录与敏感标记含义照旧保留；
 * 服务端按 id 幂等合并，重复提交安全。
 */
const legacySchema = z.looseObject({
  subIncidents: z
    .array(
      z.looseObject({
        id: z.string(),
        title: z.string().catch('未命名子事件'),
        owner: z.string().catch('未指定'),
        status: z.enum(['open', 'contained', 'closed']).catch('open')
      })
    )
    .catch([]),
  actions: z
    .array(
      z.looseObject({
        id: z.string(),
        title: z.string().catch('未命名动作'),
        kind: z.enum(['isolate', 'block', 'restore', 'notify']).catch('notify'),
        approvals: z.array(z.string()).catch([]),
        status: z.enum(['pending', 'approved', 'executed']).catch('pending'),
        sensitive: z.boolean().optional()
      })
    )
    .catch([]),
  timeline: z
    .array(
      z.looseObject({
        id: z.string(),
        at: z.string(),
        actor: z.string().catch('未知'),
        text: z.string().catch(''),
        sensitive: z.boolean().optional()
      })
    )
    .catch([])
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = legacySchema.safeParse(body);
    if (!parsed.success) return jsonError(400, '迁移数据格式不合法', 'bad_request');
    const summary = getStore().migrate(parsed.data);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return handleStoreError(error);
  }
}
