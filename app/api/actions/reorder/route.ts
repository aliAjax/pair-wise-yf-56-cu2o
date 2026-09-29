import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { reorderActions } from '@/server/store';
import { getRole, handleError, jsonOk } from '@/server/http';

const bodySchema = z.object({ orderedIds: z.array(z.string()).min(1) });

export async function POST(request: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'bad_request', message: 'orderedIds 必须为非空数组' }, { status: 400 });
    }
    const result = await reorderActions({ orderedIds: parsed.data.orderedIds, role: getRole(request) });
    return jsonOk(result);
  } catch (error) {
    return handleError(error);
  }
}
