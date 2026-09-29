import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { addSubIncident } from '@/server/store';
import { getRole, handleError, jsonOk } from '@/server/http';

const bodySchema = z.object({
  title: z.string().trim().min(4, '请填写至少4个字的子事件'),
  owner: z.string().trim().min(2, '请填写负责组')
});

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, code: 'bad_request', message: parsed.error.issues[0]?.message ?? '参数不合法' },
        { status: 400 }
      );
    }
    const result = await addSubIncident({ ...parsed.data, role: getRole(request) });
    return jsonOk(result);
  } catch (error) {
    return handleError(error);
  }
}
