# pair-wise-yf-56 网络安全事件响应作战室

## 源提示词摘要
值班人员接收告警，分析人员补充资产和影响范围，响应负责人批准隔离、封禁或恢复动作，法务和公关维护对外口径。系统展示实时事件时间线、子事件、审批、证据和责任人；高优先级动作双人确认，敏感内容按角色显示，并支持只读演示模式。

## 技术栈
Next.js 15 + TypeScript + App Router + shadcn/ui 本地组件 + Zustand + TanStack Query + React Hook Form + Zod + next-intl + date-fns + dnd-kit。

## 架构：服务端单一事实源
早期版本把事件、审批和时间线都持久化在浏览器 localStorage，导致多名值班同事看到的时间线互相对不上。现在所有处置状态集中在服务端（`lib/server/store.ts`），浏览器只保留角色、演示模式等界面偏好：

- **审批由服务端判定**：`POST /api/incident/actions/:id/approve|execute`，访客只读、隔离动作双人确认等规则全部在服务端校验。
- **敏感内容服务端裁剪**：`GET /api/incident` 按 `x-role` 请求头裁剪，敏感动作与敏感审计记录不下发给分析员/访客。
- **版本号原子确认**：每个处置动作带 `version`，确认请求携带 `expectedVersion`，服务端在同一同步代码块内校验并落变更（CAS）。两人几乎同时确认时，后到请求收到 `409 version_conflict`，客户端刷新后按新版本号自动重试；同一角色重复确认幂等，审计只记一次。
- **只追加审计时间线**：审计条目写入即冻结，模块不暴露任何修改/删除入口，并逐行追加到 `data/audit-log.jsonl`；重启后从审计文件 + 快照恢复。每条记录带服务端单调递增 `seq`，各端排序一致。
- **本地记录迁移**：首页加载时读取旧 localStorage 存档（`yf56-incident-store`），POST 到 `/api/incident/migrate`。服务端按 id 幂等合并：审批人列表取并集、状态取最远进度、敏感标记只增不减，老记录含义照旧；重复提交安全。

## API 一览
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/incident` | 按角色裁剪后的事件视图（`x-role` 头） |
| POST | `/api/incident/actions/:id/approve` | 审批，`{ role, expectedVersion }` |
| POST | `/api/incident/actions/:id/execute` | 执行，`{ role, expectedVersion }` |
| POST | `/api/incident/actions/reorder` | 调整优先级，`{ role, activeId, overId }` |
| POST | `/api/incident/sub-incidents` | 新增子事件，`{ role, title, owner }` |
| POST | `/api/incident/migrate` | 旧浏览器存档幂等迁移 |
| GET | `/api/health` | 实时通道健康检查 |

> 说明：当前角色由前端选择并通过请求头声明，用于演示服务端裁剪与判定逻辑；生产部署时应替换为真实的会话/身份体系。

## 启动
```bash
npm install
npm run dev
```
开发端口：62021
