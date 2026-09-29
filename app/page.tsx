'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Radio, ShieldAlert, UserCheck, Users } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { z } from 'zod';
import { messages } from '@/lib/messages';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiConflictError, ApiForbiddenError, approveAction, createSubIncident, executeAction, fetchIncident, reorderActions } from '@/lib/api';
import { useBootstrap } from '@/lib/use-bootstrap';
import { usePreferenceStore } from '@/lib/preferences';
import { roleNames, type ActionView, type IncidentView, type Role } from '@/lib/types';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });

interface Toast { id: number; tone: 'ok' | 'warn' | 'error'; text: string; }

interface SortableActionProps {
  action: ActionView;
  role: Role;
  demoMode: boolean;
  busy: boolean;
  onToast: (toast: Omit<Toast, 'id'>) => void;
}

function SortableActionRow({ action, role, demoMode, busy, onToast }: SortableActionProps) {
  const queryClient = useQueryClient();
  const sortable = useSortable({ id: action.id, disabled: demoMode });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['incident'] });

  const approve = useMutation({
    mutationFn: () => approveAction(action.id, action.version, role),
    onSuccess: () => { void refresh(); onToast({ tone: 'ok', text: `已确认审批：${action.title}` }); },
    onError: (error) => {
      void refresh();
      if (error instanceof ApiConflictError) onToast({ tone: 'warn', text: `${error.message}（版本已刷新）` });
      else if (error instanceof ApiForbiddenError) onToast({ tone: 'error', text: error.message });
      else onToast({ tone: 'error', text: error instanceof Error ? error.message : '审批失败' });
    }
  });

  const execute = useMutation({
    mutationFn: () => executeAction(action.id, action.version, role),
    onSuccess: () => { void refresh(); onToast({ tone: 'ok', text: `已下发执行：${action.title}` }); },
    onError: (error) => {
      void refresh();
      if (error instanceof ApiConflictError) onToast({ tone: 'warn', text: `${error.message}（版本已刷新）` });
      else if (error instanceof ApiForbiddenError) onToast({ tone: 'error', text: error.message });
      else onToast({ tone: 'error', text: error instanceof Error ? error.message : '执行失败' });
    }
  });

  const approvalText = action.requiredApprovals > 0
    ? `${action.approvals.length}/${action.requiredApprovals} 人确认`
    : action.approvals.length > 0
      ? `${action.approvals.length} 人已批`
      : '无审批';

  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <strong>{action.title}</strong>
        <div className="muted">
          {action.kind} · {approvalText} · {action.status} · v{action.version}
        </div>
      </div>
      <div className="row-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={demoMode || busy || !action.canApprove}
          onClick={() => approve.mutate()}
        >
          <UserCheck size={14} />确认审批
        </Button>
        <Button
          size="sm"
          disabled={demoMode || busy || !action.canExecute}
          onClick={() => execute.mutate()}
        >
          执行
        </Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners} disabled={demoMode}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const role = usePreferenceStore((state) => state.role);
  const demoMode = usePreferenceStore((state) => state.demoMode);
  const setRole = usePreferenceStore((state) => state.setRole);
  const toggleDemo = usePreferenceStore((state) => state.toggleDemo);
  const migration = useBootstrap();
  const queryClient = useQueryClient();
  const ready = migration.status === 'done' || migration.status === 'fresh';

  // 切角色时按新角色重新拉取，服务端会重新裁剪；4 秒轮询保证多人时间线对齐
  const incidentQuery = useQuery({
    queryKey: ['incident', role],
    queryFn: () => fetchIncident(role),
    enabled: ready,
    refetchInterval: demoMode ? false : 4000
  });
  const incident: IncidentView | undefined = incidentQuery.data;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });

  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = (toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { ...toast, id }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  };

  const createSub = useMutation({
    mutationFn: (values: { title: string; owner: string }) => createSubIncident(values, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['incident'] });
      form.reset();
      pushToast({ tone: 'ok', text: '子事件已创建并写入服务端审计' });
    },
    onError: (error) => pushToast({ tone: 'error', text: error instanceof Error ? error.message : '创建失败' })
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) => reorderActions(orderedIds, role),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['incident'] }); },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ['incident'] });
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : '排序失败' });
    }
  });

  function dragEnd(event: DragEndEvent) {
    if (!incident || demoMode || !incident.reorderable || !event.over) return;
    const ids = incident.actions.map((item) => item.id);
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over!.id));
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorder.mutate(next);
  }

  return <main className="shell">
    <header className="topbar">
      <div>
        <span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021 · SERVER-AUTHORITATIVE</span>
        <h1>{messages.title}</h1>
        <p>{messages.subtitle}</p>
      </div>
      <div className="controls">
        <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <Button variant={demoMode ? 'danger' : 'outline'} onClick={toggleDemo}><Eye size={16} />{demoMode ? '退出演示' : messages.demo}</Button>
      </div>
    </header>

    {demoMode && <div className="demo-banner">只读演示模式已开启：所有变更请求冻结在浏览器，不会提交到服务端；视图仍由服务端按当前角色裁剪。</div>}
    {migration.status === 'done' && (
      <div className="notice notice-ok">本地浏览器中的 {migration.legacyCount} 条历史处置记录已迁移为服务端只追加审计，旧审批与敏感标记语义保持不变。</div>
    )}
    {migration.status === 'error' && (
      <div className="notice notice-error">服务端引导失败：{migration.message}。请检查服务后刷新页面重试。</div>
    )}
    {!ready && <div className="notice">正在与服务端同步作战室状态…</div>}

    {ready && !incident && incidentQuery.isError && (
      <div className="notice notice-error">无法从服务端获取事件：{(incidentQuery.error as Error)?.message ?? '未知错误'}</div>
    )}

    {incident && <section className="metrics">
      <Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong style={{ fontSize: 18 }}>{incidentQuery.isFetching ? '同步中' : '已同步'}</strong><small>服务端时间 {new Date(incident.serverTime).toLocaleTimeString('zh-CN')}</small></CardContent></Card>
      <Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card>
      <Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length + incident.redacted.actions}</strong><small>已执行/总数（含{incident.redacted.actions}条被裁剪）</small></CardContent></Card>
    </section>}

    {incident && <section className="grid">
      <div className="stack">
        <Card>
          <CardHeader>
            <div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div>
            <ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} />
          </CardHeader>
          <CardContent>
            <div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div>
            <h3>子事件</h3>
            {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <h2>{messages.approval}</h2>
              <p className="muted">
                审批资格与双人确认由服务端判定，确认时携带动作版本号做原子确认；同一角色重复确认只记一次。
                {incident.redacted.actions > 0 && <span className="redacted-note"> 当前角色有 {incident.redacted.actions} 条敏感动作未下发。</span>}
              </p>
            </div>
            <Users size={20} />
          </CardHeader>
          <CardContent>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div>
                  {incident.actions.map((action) => (
                    <SortableActionRow
                      key={action.id}
                      action={action}
                      role={role}
                      demoMode={demoMode}
                      busy={reorder.isPending}
                      onToast={pushToast}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {incident.actions.length === 0 && <p className="muted">当前角色可见的处置动作为空。</p>}
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card>
          <CardHeader><h2>新增子事件</h2></CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit((values) => createSub.mutate(values))}>
              <label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label>
              <small className="error">{form.formState.errors.title?.message}</small>
              <label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label>
              <small className="error">{form.formState.errors.owner?.message}</small>
              <Button type="submit" disabled={demoMode || createSub.isPending}><ShieldAlert size={16} />创建子事件</Button>
            </form>
          </CardContent>
        </Card>
        <Card className="timeline-card">
          <CardHeader>
            <div>
              <h2>{messages.timeline}</h2>
              <p className="muted">
                只追加的服务端审计记录，任何角色都无法修改已记下的处置经过；全员轮询同一份时间线。
                {incident.redacted.timelineEvents > 0 && <span className="redacted-note"> {incident.redacted.timelineEvents} 条敏感记录未向当前角色下发。</span>}
              </p>
            </div>
            <Radio color="#ef4444" />
          </CardHeader>
          <CardContent>
            <div className="timeline">
              {incident.timeline.map((event) => (
                <article key={event.id}>
                  <i />
                  <div>
                    <div className="timeline-meta">
                      <strong>
                        {event.actor}
                        {event.legacy && <span className="legacy-tag" title="来自浏览器历史记录迁移">历史迁移</span>}
                      </strong>
                      <span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span>
                    </div>
                    <p>{event.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>}

    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.text}</div>)}
    </div>
  </main>;
}
