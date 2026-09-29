# pair-wise-yf-56 网络安全事件响应作战室

## 源提示词摘要
值班人员接收告警，分析人员补充资产和影响范围，响应负责人批准隔离、封禁或恢复动作，法务和公关维护对外口径。系统展示实时事件时间线、子事件、审批、证据和责任人；高优先级动作双人确认，敏感内容按角色显示，并支持只读演示模式。

## 技术栈
Next.js 15 + TypeScript + App Router（Route Handlers）+ shadcn/ui 本地组件 + Zustand（仅偏好）+ TanStack Query + React Hook Form + Zod + next-intl + date-fns + dnd-kit。

## 服务端权威化改造（当前版本）
所有处置状态以服务端为唯一事实源，浏览器不再保存任何处置记录：

- **服务端判定审批**：审批资格、隔离动作双人确认（`isolate` 需 2 名不同角色，其余动作沿用旧规则）全部在 `server/store.ts` 判定，客户端只回传动作版本号。
- **按角色服务端裁剪**：敏感动作和敏感时间线在服务端就被剔除（不是下发后遮蔽），无权角色拿不到标题等任何字段；`redacted` 只回传被裁剪的条数。只有能看到全部动作的角色能调整优先级，排序接口校验完整动作集合。
- **动作版本号原子确认**：每个动作带 `version`。两人几乎同时确认时，临界区内先到的成功并递增版本，后到的旧版本请求得到 `409 version_conflict`（响应带回最新版本）；同一角色重复确认幂等——只记一次审计、不重复计数。
- **只追加审计时间线**：时间线存为 `.data/audit.ndjson`，代码里只有 append 路径，没有任何修改/删除历史条目的入口；所有变更在进程内互斥锁内完成（读状态→判定→写状态+追加审计），状态写入用临时文件 + rename。
- **全员共享时间线**：监测心跳由服务端按 20 秒节流生成（任何角色的轮询都可能触发，但全局只有一条），值班同事轮询同一份视图，不再各走各的本地时钟。
- **浏览器老记录迁移**：首次打开时客户端读取旧 `yf56-incident-store` localStorage 上报 `/api/bootstrap`；服务端互斥引导，并发首次打开只有第一份落库。旧 `approvals`/`sensitive`/`status` 语义不变，历史时间线按时间正序逐条写入审计并打 `legacy` 标记，迁移完成后本地老 key 改存为 `.migrated-backup` 备份。
- localStorage 仅保留角色与只读演示模式偏好（`yf56-preferences`）。

## 接口
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/bootstrap` | 首次引导/迁移，body `{ legacy: 旧记录 \| null }`，幂等 |
| GET | `/api/incident` | 按 `x-role` 头裁剪的事件视图，附带共享监测心跳 |
| POST | `/api/actions/:id/approve` | body `{ expectedVersion }`，原子审批 |
| POST | `/api/actions/:id/execute` | body `{ expectedVersion }`，双人确认不齐则 403 |
| POST | `/api/actions/reorder` | body `{ orderedIds: string[] }`，必须与服务端集合完全一致 |
| POST | `/api/sub-incidents` | 创建子事件 |

角色通过 `x-role: analyst | responder | legal | viewer` 请求头传入，非法值按最小权限 `viewer` 处理。

## 数据存储
默认写入工作目录 `.data/`（`state.json` + `audit.ndjson`，已 gitignore），可用环境变量 `WARROOM_DATA_DIR` 覆盖。

## 启动
```bash
npm install
npm run dev
```
开发端口：62021
