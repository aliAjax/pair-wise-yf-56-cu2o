import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { executeAction } from '@/server/store';
import { getRole, handleError, jsonOk } from '@/server/http';

const bodySchema = z.object({ expectedVersion: z.number().int().nonnegative() });

// 隔离动作未满足双人确认时，服务端直接拒绝执行。
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'bad_request', message: 'expectedVersion 必须为非负整数' }, { status: 400 });
    }
    const result = await executeAction({
      actionId: id,
      role: getRole(request),
      expectedVersion: parsed.data.expectedVersion
    });
    return jsonOk(result);
  } catch (error) {
    return handleError(error);
  }
}
