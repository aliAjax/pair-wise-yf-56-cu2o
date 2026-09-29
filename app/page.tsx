'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Eye, Radio, ShieldAlert, UserCheck, Users } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useUiStore } from '@/lib/store';
import type { IncidentView, ResponseAction, Role } from '@/lib/types';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
const LEGACY_STORE_KEY = 'yf56-incident-store';
const MIGRATE_SENT_KEY = 'yf56-migrate-sent';
const TIMELINE_RENDER_LIMIT = 50;

function SortableAction({ action, role, demoMode, busy, onApprove, onExecute }: {
  action: ResponseAction;
  role: Role;
  demoMode: boolean;
  busy: boolean;
  onApprove: (id: string) => void;
  onExecute: (id: string) => void;
}) {
  const sortable = useSortable({ id: action.id });
  const approved = action.approvals.includes(role);
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <strong>{action.title}</strong>
        <div className="muted">
          {action.kind} · 审批人 {action.approvals.map((item) => roleNames[item]).join('、') || '无'} · {action.status} · v{action.version}
          {action.sensitive ? ' · 敏感' : ''}
        </div>
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={demoMode || busy || role === 'viewer' || approved || action.status === 'executed'} onClick={() => onApprove(action.id)}><UserCheck size={14} />{approved ? '已审批' : '审批'}</Button>
        <Button size="sm" disabled={demoMode || busy || role === 'viewer' || action.status === 'executed'} onClick={() => onExecute(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { role, demoMode, setRole, toggleDemo } = useUiStore();
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });

  const incidentQuery = useQuery({ queryKey: ['incident', role], queryFn: () => api.getIncident(role), refetchInterval: 2000, placeholderData: (prev) => prev });
  const incident = incidentQuery.data;
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: api.health, refetchInterval: 10000, retry: false });

  // 旧版本地处置记录一次性迁移到服务端；服务端按 id 幂等合并，重复提交安全。
  useEffect(() => {
    if (sessionStorage.getItem(MIGRATE_SENT_KEY)) return;
    sessionStorage.setItem(MIGRATE_SENT_KEY, '1');
    const raw = localStorage.getItem(LEGACY_STORE_KEY);
    if (!raw) return;
    try {
      const legacy = JSON.parse(raw)?.state?.incident;
      if (!legacy) return;
      api.migrate(legacy)
        .then(() => queryClient.invalidateQueries({ queryKey: ['incident'] }))
        .catch(() => sessionStorage.removeItem(MIGRATE_SENT_KEY));
    } catch {
      // 旧存档损坏则跳过迁移
    }
  }, [queryClient]);

  // 确认动作：带上本地看到的版本号，服务端原子校验；版本冲突时刷新后按新版本重试。
  async function confirmWithRetry(kind: 'approve' | 'execute', id: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const view = queryClient.getQueryData<IncidentView>(['incident', role]) ?? (await api.getIncident(role));
      const action = view.actions.find((item) => item.id === id);
      if (!action) throw new Error('动作不存在或当前角色不可见');
      if (kind === 'approve' && action.approvals.includes(role)) return;
      if (kind === 'execute' && action.status === 'executed') return;
      try {
        if (kind === 'approve') await api.approve(id, role, action.version);
        else await api.execute(id, role, action.version);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === 'version_conflict') {
          await queryClient.refetchQueries({ queryKey: ['incident', role] });
          continue;
        }
        throw error;
      }
    }
    throw new Error('多人同时操作，冲突频繁，请稍后重试');
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['incident'] });
  const approveMutation = useMutation({ mutationFn: (id: string) => confirmWithRetry('approve', id), onSuccess: invalidate });
  const executeMutation = useMutation({ mutationFn: (id: string) => confirmWithRetry('execute', id), onSuccess: invalidate });
  const reorderMutation = useMutation({ mutationFn: ({ activeId, overId }: { activeId: string; overId: string }) => api.reorder(role, activeId, overId), onSuccess: invalidate });
  const subIncidentMutation = useMutation({ mutationFn: (values: z.infer<typeof formSchema>) => api.addSubIncident(role, values), onSuccess: () => { form.reset(); invalidate(); } });

  function dragEnd(event: DragEndEvent) {
    if (event.over && !demoMode) reorderMutation.mutate({ activeId: String(event.active.id), overId: String(event.over.id) });
  }

  const actionError = approveMutation.error ?? executeMutation.error ?? reorderMutation.error ?? subIncidentMutation.error;
  const busy = approveMutation.isPending || executeMutation.isPending;

  if (!incident) {
    return <main className="shell"><div className="demo-banner">{incidentQuery.isError ? '无法连接服务端，请确认服务已启动。' : '正在连接服务端作战室…'}</div></main>;
  }

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={role} onChange={(event) => setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={demoMode ? 'danger' : 'outline'} onClick={toggleDemo}><Eye size={16} />{demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    {actionError && <div className="demo-banner">操作失败：{actionError.message}</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '服务端监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/可见总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{incident.status}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">审批由服务端判定：隔离动作需两名不同角色按版本号原子确认，重复确认只记一次；敏感动作仅响应和法务角色可见。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} role={role} demoMode={demoMode} busy={busy} onApprove={(id) => approveMutation.mutate(id)} onExecute={(id) => executeMutation.mutate(id)} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => subIncidentMutation.mutate(values))}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={demoMode || subIncidentMutation.isPending}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">服务端只追加审计记录，每 20 秒由服务端监测代理追加一条</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.slice(0, TIMELINE_RENDER_LIMIT).map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}{event.sensitive ? '（敏感）' : ''}</strong><span>#{event.seq} · {formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.text}</p></div></article>)}</div>{incident.timeline.length > TIMELINE_RENDER_LIMIT && <p className="muted">仅展示最近 {TIMELINE_RENDER_LIMIT} 条，完整审计记录保存在服务端，不可修改。</p>}</CardContent></Card>
      </div>
    </section>
  </main>;
}
