import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { bootstrap, type LegacyIncident } from '@/server/store';
import { handleError } from '@/server/http';

// 老浏览器记录的形状：只做宽松校验，能认的就原样迁移，语义不变。
const legacyRole = z.string();
const legacyEventSchema = z.object({
  id: z.unknown().optional(),
  at: z.string().optional(),
  actor: z.string().optional(),
  text: z.string().optional(),
  sensitive: z.boolean().optional()
});
const legacyActionSchema = z.object({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  kind: z.unknown().optional(),
  approvals: z.array(legacyRole).optional(),
  status: z.unknown().optional(),
  sensitive: z.boolean().optional()
});
const legacySubSchema = z.object({
  id: z.unknown().optional(),
  title: z.unknown().optional(),
  owner: z.unknown().optional(),
  status: z.unknown().optional()
});
const legacyIncidentSchema = z.object({
  id: z.string().catch('INC-2026-0929'),
  title: z.string().catch('迁移的安全事件'),
  severity: z.enum(['medium', 'high', 'critical']).catch('high'),
  status: z.enum(['investigating', 'contained', 'recovered']).catch('investigating'),
  affected: z.array(z.string()).catch([]),
  subIncidents: z.array(legacySubSchema).catch([]),
  actions: z.array(legacyActionSchema).catch([]),
  timeline: z.array(legacyEventSchema).catch([])
});

const bodySchema = z.object({ legacy: legacyIncidentSchema.nullable() });

export async function POST(request: NextRequest) {
  try {
    let payload: unknown = null;
    try {
      payload = await request.json();
    } catch {
      payload = { legacy: null };
    }
    const parsed = bodySchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'bad_request', message: '引导参数无法解析' }, { status: 400 });
    }
    const result = await bootstrap(parsed.data.legacy as LegacyIncident | null);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return handleError(error);
  }
}
