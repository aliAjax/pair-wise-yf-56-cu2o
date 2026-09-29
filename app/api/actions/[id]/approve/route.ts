import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { approveAction } from '@/server/store';
import { getRole, handleError, jsonOk } from '@/server/http';

const bodySchema = z.object({ expectedVersion: z.number().int().nonnegative() });

// 服务端判定审批：谁能批、审批是否满足隔离动作双人确认、版本是否仍然最新，全在这里。
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'bad_request', message: 'expectedVersion 必须为非负整数' }, { status: 400 });
    }
    const result = await approveAction({
      actionId: id,
      role: getRole(request),
      expectedVersion: parsed.data.expectedVersion
    });
    return jsonOk(result);
  } catch (error) {
    return handleError(error);
  }
}
