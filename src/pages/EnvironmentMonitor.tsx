import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CloudSun,
  Database, LoaderCircle, Plus, RefreshCw, Search, Settings, Signal, Trash2, WifiOff, X
} from 'lucide-react';

interface ProjectNode { id: string; code?: string; name: string; level: number; children?: ProjectNode[]; }
interface ProjectOption { id: number; label: string; }
interface EnvironmentReading {
  id: string; project_id: number; project_code: string; project_name: string; group_id: string;
  device_addr: string; device_name: string; device_status: string; node_id: number; register_id: number;
  factor_id: string; factor_name: string; function_code: string | null; function_name: string | null;
  data_type: string | null; data_text: string; value: number | null; unit: string;
  alarm_level: number | null; alarm_color: string; alarm_info: string; sample_time: string; received_at: string;
}
interface EnvironmentConfig {
  id: number; project_id: number; project_code: string; project_name: string; name: string;
  api_base_url: string; mqtt_broker: string; login_name: string; group_id: string; group_name: string;
  enabled: boolean; connection_status: string; last_error: string | null; last_received_at: string | null;
}
interface RemoteGroup { groupId: string; groupName: string; parentId: string; }

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });
const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const toLocalInput = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const defaultStart = () => { const date = new Date(); date.setDate(date.getDate() - 7); date.setHours(0, 0, 0, 0); return toLocalInput(date); };
const flattenProjects = (nodes: ProjectNode[], depth = 0): ProjectOption[] => nodes.flatMap((node) => [
  { id: Number(node.id), label: `${'　'.repeat(depth)}${node.name}${node.code ? ` (${node.code})` : ''}` },
  ...flattenProjects(node.children || [], depth + 1)
]);
const statusView = (status: string) => {
  if (status === 'CONNECTED') return { label: '已连接', className: 'bg-emerald-100 text-emerald-700', Icon: CheckCircle2 };
  if (status === 'CONNECTING') return { label: '连接中', className: 'bg-amber-100 text-amber-700', Icon: LoaderCircle };
  if (status === 'ERROR') return { label: '异常', className: 'bg-red-100 text-red-700', Icon: AlertTriangle };
  return { label: '未连接', className: 'bg-gray-100 text-gray-600', Icon: WifiOff };
};

const emptyForm = () => ({
  name: '', projectId: '', apiBaseUrl: 'http://www.0531yun.com',
  mqttBroker: 'mqtt://rtd.mqtt.0531yun.com:1883', loginName: '', password: '',
  groupId: '', groupName: '', enabled: true
});

interface EnvironmentMonitorProps { view: 'config' | 'data'; }

const EnvironmentMonitor: React.FC<EnvironmentMonitorProps> = ({ view }) => {
  const currentUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
  }, []);
  const isAdmin = currentUser.role === 'ADMIN';
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [configs, setConfigs] = useState<EnvironmentConfig[]>([]);
  const [readings, setReadings] = useState<EnvironmentReading[]>([]);
  const [summary, setSummary] = useState({ total: 0, today_count: 0, device_count: 0, latest_received_at: null as string | null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(() => toLocalInput(new Date()));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [groups, setGroups] = useState<RemoteGroup[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState('');

  const loadProjects = useCallback(async () => {
    const response = await fetch('/api/projects', { headers: authHeaders() });
    const result = await response.json();
    if (response.ok && result.success) setProjects(flattenProjects(result.data || []));
  }, []);

  const loadConfigs = useCallback(async () => {
    if (!isAdmin) return;
    const response = await fetch('/api/environment-monitor/configs', { headers: authHeaders() });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '读取接口配置失败');
    setConfigs(result.data || []);
  }, [isAdmin]);

  const loadReadings = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (projectId) params.set('projectId', projectId);
      if (start) params.set('start', new Date(start).toISOString());
      if (end) params.set('end', new Date(end).toISOString());
      const response = await fetch(`/api/environment-monitor/readings?${params}`, { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '读取环境监测数据失败');
      setReadings(result.data || []); setSummary(result.summary || { total: 0, today_count: 0, device_count: 0, latest_received_at: null });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取环境监测数据失败');
    } finally { setLoading(false); }
  }, [end, page, pageSize, projectId, search, start]);

  useEffect(() => {
    loadProjects().catch(() => setError('读取项目列表失败'));
  }, [loadProjects]);
  useEffect(() => {
    if (view === 'config' && isAdmin) loadConfigs().catch((reason) => setError(reason instanceof Error ? reason.message : '读取接口配置失败'));
  }, [isAdmin, loadConfigs, view]);
  useEffect(() => {
    if (view === 'data') loadReadings();
  }, [loadReadings, view]);

  const openNew = () => {
    setEditingId(null); setForm(emptyForm()); setGroups([]); setModalError(''); setModalOpen(true);
  };
  const openEdit = (config: EnvironmentConfig) => {
    setEditingId(config.id); setGroups([]); setModalError('');
    setForm({
      name: config.name, projectId: String(config.project_id), apiBaseUrl: config.api_base_url,
      mqttBroker: config.mqtt_broker, loginName: config.login_name, password: '',
      groupId: config.group_id, groupName: config.group_name, enabled: config.enabled
    });
    setModalOpen(true);
  };

  const fetchGroups = async () => {
    setGroupLoading(true); setModalError('');
    try {
      const useSavedCredentials = Boolean(editingId && !form.password);
      const response = useSavedCredentials
        ? await fetch(`/api/environment-monitor/configs/${editingId}/groups`, { headers: authHeaders() })
        : await fetch('/api/environment-monitor/remote/groups', {
          method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiBaseUrl: form.apiBaseUrl, loginName: form.loginName, password: form.password })
        });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '获取云平台分组失败');
      setGroups(result.data || []);
      if (form.groupId && !result.data?.some((group: RemoteGroup) => group.groupId === form.groupId)) {
        setForm((current) => ({ ...current, groupId: '', groupName: '' }));
      }
      if (!result.data?.length) setModalError('当前账号没有可用分组');
    } catch (reason) { setModalError(reason instanceof Error ? reason.message : '获取云平台分组失败'); }
    finally { setGroupLoading(false); }
  };

  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setModalError('');
    try {
      const selectedGroup = groups.find((group) => group.groupId === form.groupId);
      const response = await fetch(editingId ? `/api/environment-monitor/configs/${editingId}` : '/api/environment-monitor/configs', {
        method: editingId ? 'PUT' : 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, projectId: Number(form.projectId), groupName: selectedGroup?.groupName || form.groupName })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '保存配置失败');
      setModalOpen(false); await loadConfigs();
    } catch (reason) { setModalError(reason instanceof Error ? reason.message : '保存配置失败'); }
    finally { setSaving(false); }
  };

  const deleteConfig = async (config: EnvironmentConfig) => {
    if (!confirm(`确定删除“${config.name}”吗？历史环境监测记录会保留。`)) return;
    try {
      const response = await fetch(`/api/environment-monitor/configs/${config.id}`, { method: 'DELETE', headers: authHeaders() });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || '删除配置失败');
      await loadConfigs();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除配置失败'); }
  };

  const totalPages = Math.max(1, Math.ceil(summary.total / pageSize));
  const applySearch = () => { setPage(1); setSearch(searchInput.trim()); };
  const statCards = [
    ['查询记录', summary.total, Database, 'bg-blue-50 text-blue-600'],
    ['今日记录', summary.today_count, Activity, 'bg-emerald-50 text-emerald-600'],
    ['设备数量', summary.device_count, Signal, 'bg-violet-50 text-violet-600'],
    ['最近接收', formatTime(summary.latest_received_at), CloudSun, 'bg-amber-50 text-amber-600']
  ] as const;

  if (view === 'config' && !isAdmin) return <Navigate to="/environment-monitor/data" replace />;

  return <div className="space-y-5">
    <nav className="flex gap-2 border-b border-gray-200" aria-label="环境监测子页面">
      {isAdmin && <Link to="/environment-monitor/config" className={`px-4 py-2.5 text-sm border-b-2 transition-colors ${view === 'config' ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>平台接口配置</Link>}
      <Link to="/environment-monitor/data" className={`px-4 py-2.5 text-sm border-b-2 transition-colors ${view === 'data' ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>环境监测数据</Link>
    </nav>

    {view === 'data' && <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {statCards.map(([label, value, Icon, color]) => <div key={label} className="bg-white rounded-xl shadow-sm p-4 flex items-center gap-3">
        <div className={`${color} rounded-lg p-3`}><Icon className="w-5 h-5" /></div>
        <div className="min-w-0"><div className="text-sm text-gray-500">{label}</div><div className="text-xl font-semibold text-gray-800 truncate">{value}</div></div>
      </div>)}
    </div>}

    {view === 'config' && isAdmin && <section className="bg-white rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-4 border-b flex items-center justify-between gap-3">
        <div><h2 className="font-semibold text-gray-800">平台接口配置</h2><p className="text-xs text-gray-500 mt-1">账号用于获取分组，实时数据通过协议指定的 MQTT 主题接收。</p></div>
        <button onClick={openNew} className="shrink-0 inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-sm"><Plus className="w-4 h-4" />新增配置</button>
      </div>
      <div className="overflow-x-auto"><table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50"><tr>{['配置名称', '项目', '云平台分组', '连接状态', '最近接收', '操作'].map((title) => <th key={title} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{title}</th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100">{!configs.length ? <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">尚未配置环境监测平台</td></tr> : configs.map((config) => {
          const status = statusView(config.connection_status);
          const StatusIcon = status.Icon;
          return <tr key={config.id} className="hover:bg-gray-50">
            <td className="px-4 py-3 text-sm font-medium text-gray-800 whitespace-nowrap">{config.name}</td>
            <td className="px-4 py-3 text-sm whitespace-nowrap">{config.project_name}<span className="ml-1 text-xs text-gray-400">{config.project_code}</span></td>
            <td className="px-4 py-3 text-sm whitespace-nowrap">{config.group_name || config.group_id}<span className="ml-1 text-xs text-gray-400">{config.group_id}</span></td>
            <td className="px-4 py-3 whitespace-nowrap"><span title={config.last_error || undefined} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs ${status.className}`}><StatusIcon className={`w-3.5 h-3.5 ${config.connection_status === 'CONNECTING' ? 'animate-spin' : ''}`} />{config.enabled ? status.label : '已停用'}</span></td>
            <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatTime(config.last_received_at)}</td>
            <td className="px-4 py-3 whitespace-nowrap"><div className="flex gap-2"><button onClick={() => openEdit(config)} className="text-blue-600 hover:text-blue-800 p-1" title="编辑"><Settings className="w-4 h-4" /></button><button onClick={() => deleteConfig(config)} className="text-red-500 hover:text-red-700 p-1" title="删除"><Trash2 className="w-4 h-4" /></button></div></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>}

    {view === 'data' && <>
    <section className="bg-white rounded-xl shadow-sm p-4">
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 items-center ${isAdmin ? 'xl:grid-cols-[minmax(220px,1fr)_minmax(150px,0.8fr)_minmax(170px,0.9fr)_minmax(170px,0.9fr)_auto_auto]' : 'xl:grid-cols-[minmax(260px,1fr)_minmax(170px,1fr)_minmax(170px,1fr)_auto_auto]'}`}>
        <div className="relative min-w-0"><Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" /><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && applySearch()} placeholder="搜索项目、设备地址或监测因子" className="w-full min-w-0 pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" /></div>
        {isAdmin && <select value={projectId} onChange={(event) => { setPage(1); setProjectId(event.target.value); }} className="w-full min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select>}
        <input type="datetime-local" value={start} onChange={(event) => { setPage(1); setStart(event.target.value); }} className="w-full min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input type="datetime-local" value={end} onChange={(event) => { setPage(1); setEnd(event.target.value); }} className="w-full min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <button onClick={applySearch} className="w-full xl:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm">查询</button>
        <button onClick={loadReadings} className="w-full xl:w-auto px-4 py-2 border border-gray-300 rounded-lg text-sm inline-flex items-center justify-center gap-1.5"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
      </div>
    </section>

    {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{error}</div>}
    <section className="bg-white rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-4 border-b"><h2 className="font-semibold text-gray-800">环境监测数据</h2><p className="text-xs text-gray-500 mt-1">每条记录对应一个设备节点下的一个监测因子。</p></div>
      <div className="overflow-x-auto"><table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50"><tr>{['接收时间', '监测时间', '所属项目', '设备', '环境因子 / 功能码', '监测值', '报警状态'].map((title) => <th key={title} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{title}</th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100">{loading && !readings.length ? <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">正在加载…</td></tr> : !readings.length ? <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">暂无环境监测数据，请先配置云平台分组并开启 MQTT 接收</td></tr> : readings.map((reading) => {
          const alarming = (reading.alarm_level ?? 0) !== 0;
          return <tr key={`${reading.id}-${reading.sample_time}`} className="hover:bg-gray-50">
            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatTime(reading.received_at)}</td>
            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatTime(reading.sample_time)}</td>
            <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.project_name}<span className="ml-1 text-xs text-gray-400">{reading.project_code}</span></td>
            <td className="px-4 py-3 text-sm whitespace-nowrap"><div className="font-medium">{reading.device_name || reading.device_addr}</div><div className="text-xs text-gray-400">地址 {reading.device_addr} · {reading.device_status || '状态未知'}</div></td>
            <td className="px-4 py-3 text-sm"><div className="font-medium">{reading.function_name || reading.factor_name || '未命名因子'}</div><div className="text-xs text-gray-500">功能码：{reading.function_code || '未匹配'} · 节点 {reading.node_id} / 寄存器 {reading.register_id}</div></td>
            <td className="px-4 py-3 text-sm font-semibold text-blue-700 whitespace-nowrap">{reading.data_text || (reading.value == null ? '-' : String(reading.value))} <span className="font-normal text-gray-500">{reading.unit}</span></td>
            <td className="px-4 py-3 text-sm whitespace-nowrap">{alarming ? <span className="inline-flex items-center gap-1 text-amber-700" title={reading.alarm_info}><AlertTriangle className="w-4 h-4" />级别 {reading.alarm_level}</span> : <span className="text-emerald-600">正常</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <div className="px-4 py-3 border-t flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <span>共 {summary.total} 条，第 {page} / {totalPages} 页</span>
        <div className="flex items-center gap-2"><select value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }} className="border rounded-lg px-2 py-1 text-sm">{[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size} 条/页</option>)}</select><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="p-2 border rounded-lg disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button><button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="p-2 border rounded-lg disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button></div>
      </div>
    </section>
    </>}

    {view === 'config' && modalOpen && <div className="fixed inset-0 z-50 bg-black/40 p-4 flex items-center justify-center" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}>
      <form onSubmit={saveConfig} className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-5 py-4 border-b flex items-center justify-between"><div><h3 className="text-lg font-semibold text-gray-800">{editingId ? '编辑环境监测接口' : '新增环境监测接口'}</h3><p className="text-xs text-gray-500 mt-1">登录信息将加密保存；实时数据由服务端订阅云平台 MQTT。</p></div><button type="button" onClick={() => setModalOpen(false)} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button></div>
        <div className="p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
          <label className="text-sm text-gray-600">配置名称<input required maxLength={128} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：园区环境监测" className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800" /></label>
            <label className="text-sm text-gray-600">绑定项目<select required value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800"><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}</select></label>
            <label className="text-sm text-gray-600">云平台 API 地址<input required value={form.apiBaseUrl} onChange={(event) => setForm({ ...form, apiBaseUrl: event.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800" /><span className="mt-1 block text-xs text-amber-700">协议示例使用 HTTP；如云平台支持 HTTPS，建议优先填写 HTTPS 地址。</span></label>
            <label className="text-sm text-gray-600">MQTT Broker<input required value={form.mqttBroker} onChange={(event) => setForm({ ...form, mqttBroker: event.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800" /></label>
            <label className="text-sm text-gray-600">平台登录名<input required autoComplete="username" value={form.loginName} onChange={(event) => setForm({ ...form, loginName: event.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800" /></label>
            <label className="text-sm text-gray-600">平台密码{editingId && <span className="text-xs text-gray-400">（留空保持不变）</span>}<input required={!editingId} type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800" /></label>
          </div>
          <div className="rounded-lg border border-gray-200 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-medium text-gray-800">云平台分组</div><div className="text-xs text-gray-500 mt-0.5">保存后会订阅主题 rtd/分组编号</div></div><button type="button" disabled={groupLoading || (!form.password && !editingId)} onClick={fetchGroups} className="inline-flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${groupLoading ? 'animate-spin' : ''}`} />{groupLoading ? '正在获取' : '获取分组'}</button></div>
            <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm text-gray-600">分组<select required value={form.groupId} onChange={(event) => { const group = groups.find((item) => item.groupId === event.target.value); setForm({ ...form, groupId: event.target.value, groupName: group?.groupName || '' }); }} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800"><option value="">请先获取并选择分组</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.groupName || group.groupId} ({group.groupId})</option>)}{form.groupId && !groups.some((group) => group.groupId === form.groupId) && <option value={form.groupId}>{form.groupName || form.groupId} ({form.groupId})</option>}</select></label><label className="text-sm text-gray-600">启用状态<select value={form.enabled ? 'true' : 'false'} onChange={(event) => setForm({ ...form, enabled: event.target.value === 'true' })} className="mt-1 w-full border rounded-lg px-3 py-2 text-gray-800"><option value="true">启用接收</option><option value="false">停用接收</option></select></label></div>
          </div>
          {modalError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{modalError}</div>}
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2"><button type="button" onClick={() => setModalOpen(false)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm">{saving ? '正在保存…' : '保存并连接'}</button></div>
      </form>
    </div>}
  </div>;
};

export default EnvironmentMonitor;
