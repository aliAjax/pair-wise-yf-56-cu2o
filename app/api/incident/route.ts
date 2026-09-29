import { type NextRequest } from 'next/server';
import { getRole, handleError, jsonOk } from '@/server/http';
import { pollView } from '@/server/store';

// 拉取按当前角色裁剪过的事件视图；轮询时顺带在服务端节流生成共享监测心跳，
// 所有值班同事因此看到同一条时间线，而不是各自浏览器各走各的钟。
export async function GET(request: NextRequest) {
  try {
    const view = await pollView(getRole(request));
    return jsonOk(view);
  } catch (error) {
    return handleError(error);
  }
}
