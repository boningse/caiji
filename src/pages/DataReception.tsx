import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity, BatteryCharging, ChevronLeft, ChevronRight, Clock3, Database,
  Droplets, Gauge, RefreshCw, Search, Zap
} from 'lucide-react';

interface MeterReading {
  id: string; meter_no: string; device_name?: string; project_code?: string; project_name?: string;
  acc: string; valve: '开阀' | '关阀'; mcu: number | null; voltage: string | null;
  report_time: string; received_at: string;
}

interface ElectricalReading {
  id: string; device_code: string; point_name?: string; insname: string; propertyno: string;
  paraname: string; quality: number; value: string; project_code?: string; project_name?: string;
  report_time: string; received_at: string;
}

interface MeterSummary { total: number; today: number; meter_count: number; latest_received_at: string | null; }
interface ElectricalSummary { total: number; today: number; point_count: number; latest_received_at: string | null; }

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });
const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const toLocalInput = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const initialStart = () => {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  date.setHours(0, 0, 0, 0);
  return toLocalInput(date);
};

const Pagination: React.FC<{
  total: number; page: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void;
}> = ({ total, page, pageSize, onPage, onPageSize }) => {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  return <div className="px-4 py-3 border-t flex items-center justify-between">
    <span className="text-sm text-gray-500">共 {total} 条，第 {page} / {totalPages} 页</span>
    <div className="flex gap-2">
      <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))} className="border rounded-lg px-2 text-sm">
        {[10, 20, 50, 100].map((size) => <option key={size}>{size}</option>)}
      </select>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="p-2 border rounded-lg disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="p-2 border rounded-lg disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
    </div>
  </div>;
};

const Filters: React.FC<{
  searchInput: string; setSearchInput: (value: string) => void; start: string; setStart: (value: string) => void;
  end: string; setEnd: (value: string) => void; loading: boolean; placeholder: string; onSearch: () => void; onRefresh: () => void;
}> = ({ searchInput, setSearchInput, start, setStart, end, setEnd, loading, placeholder, onSearch, onRefresh }) =>
  <div className="bg-white rounded-xl shadow-sm p-4"><div className="flex flex-col xl:flex-row xl:items-center gap-3">
    <div className="relative flex-1 min-w-64">
      <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
      <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onSearch()}
        placeholder={placeholder} className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
    </div>
    <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
    <span className="hidden xl:block text-gray-400">—</span>
    <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
    <button onClick={onSearch} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">查询</button>
    <button onClick={onRefresh} className="px-4 py-2 border border-gray-300 rounded-lg text-sm flex items-center justify-center gap-1.5">
      <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />刷新
    </button>
  </div></div>;

const SummaryCards: React.FC<{ cards: ReadonlyArray<readonly [string, string | number, React.ElementType, string]> }> = ({ cards }) =>
  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
    {cards.map(([label, value, Icon, color]) => <div key={label} className="bg-white rounded-xl shadow-sm p-4 flex items-center gap-3">
      <div className={`${color} rounded-lg p-3`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0"><div className="text-sm text-gray-500">{label}</div><div className="text-xl font-semibold text-gray-800 truncate">{value}</div></div>
    </div>)}
  </div>;

const WaterReception: React.FC = () => {
  const [readings, setReadings] = useState<MeterReading[]>([]);
  const [summary, setSummary] = useState<MeterSummary>({ total: 0, today: 0, meter_count: 0, latest_received_at: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(() => toLocalInput(new Date()));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const fetchReadings = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (start) params.set('start', new Date(start).toISOString());
      if (end) params.set('end', new Date(end).toISOString());
      const response = await fetch(`/api/meter/readings?${params}`, { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.msg || '载入水表数据失败');
      setReadings(result.data || []); setSummary(result.summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '载入水表数据失败'); }
    finally { setLoading(false); }
  }, [page, pageSize, search, start, end]);

  useEffect(() => { fetchReadings(); }, [fetchReadings]);
  const applySearch = () => { setPage(1); setSearch(searchInput.trim()); };
  const cards = [
    ['接收记录', summary.total, Droplets, 'bg-blue-50 text-blue-600'],
    ['今日接收', summary.today, Clock3, 'bg-emerald-50 text-emerald-600'],
    ['水表数量', summary.meter_count, Gauge, 'bg-violet-50 text-violet-600'],
    ['最近接收', formatTime(summary.latest_received_at), BatteryCharging, 'bg-amber-50 text-amber-600']
  ] as const;

  return <div className="space-y-4">
    <SummaryCards cards={cards} />
    <Filters {...{ searchInput, setSearchInput, start, setStart, end, setEnd, loading }} placeholder="搜索表号 / 设备名称 / 项目" onSearch={applySearch} onRefresh={fetchReadings} />
    {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{error}</div>}
    <div className="bg-white rounded-xl shadow-sm overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full divide-y divide-gray-200">
      <thead className="bg-gray-50"><tr>{['接收时间', '抄表时间', '水表表号', '设备名称', '所属项目', '累计用量', '阀门状态', '信号强度', '电池电压'].map((label) => <th key={label} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100">{!loading && !readings.length ? <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-500">暂无水表上报数据</td></tr> : readings.map((reading) => <tr key={reading.id} className="hover:bg-gray-50">
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatTime(reading.received_at)}</td>
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatTime(reading.report_time)}</td>
        <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">{reading.meter_no}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.device_name || '-'}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.project_name || '-'}{reading.project_code && <span className="ml-1 text-xs text-gray-400">({reading.project_code})</span>}</td>
        <td className="px-4 py-3 text-sm font-semibold text-blue-600 whitespace-nowrap">{reading.acc} m³</td>
        <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs ${reading.valve === '开阀' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{reading.valve}</span></td>
        <td className="px-4 py-3 text-sm">{reading.mcu ?? '-'}</td><td className="px-4 py-3 text-sm">{reading.voltage == null ? '-' : `${reading.voltage} V`}</td>
      </tr>)}</tbody>
    </table></div><Pagination total={summary.total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} /></div>
  </div>;
};

const ElectricalReception: React.FC = () => {
  const [readings, setReadings] = useState<ElectricalReading[]>([]);
  const [summary, setSummary] = useState<ElectricalSummary>({ total: 0, today: 0, point_count: 0, latest_received_at: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(() => toLocalInput(new Date()));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const fetchReadings = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (start) params.set('start', new Date(start).toISOString());
      if (end) params.set('end', new Date(end).toISOString());
      const response = await fetch(`/api/electrical/readings?${params}`, { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.msg || '载入电气数据失败');
      setReadings(result.data || []); setSummary(result.summary);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '载入电气数据失败'); }
    finally { setLoading(false); }
  }, [page, pageSize, search, start, end]);

  useEffect(() => { fetchReadings(); }, [fetchReadings]);
  const applySearch = () => { setPage(1); setSearch(searchInput.trim()); };
  const cards = [
    ['接收记录', summary.total, Zap, 'bg-blue-50 text-blue-600'],
    ['今日接收', summary.today, Clock3, 'bg-emerald-50 text-emerald-600'],
    ['接入点位', summary.point_count, Activity, 'bg-violet-50 text-violet-600'],
    ['最近接收', formatTime(summary.latest_received_at), Database, 'bg-amber-50 text-amber-600']
  ] as const;

  return <div className="space-y-4">
    <SummaryCards cards={cards} />
    <Filters {...{ searchInput, setSearchInput, start, setStart, end, setEnd, loading }} placeholder="搜索设备地址 / 点位 / 参数 / 项目" onSearch={applySearch} onRefresh={fetchReadings} />
    {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{error}</div>}
    <div className="bg-white rounded-xl shadow-sm overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full divide-y divide-gray-200">
      <thead className="bg-gray-50"><tr>{['接收时间', '数据时间', '设备地址', '点位名称', '点位标识', '属性号', '参数名称', '数值', '质量', '所属项目'].map((label) => <th key={label} className="px-4 py-3 text-left text-xs font-medium text-gray-500 whitespace-nowrap">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100">{!loading && !readings.length ? <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">暂无厂家推送的电气数据</td></tr> : readings.map((reading) => <tr key={reading.id} className="hover:bg-gray-50">
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatTime(reading.received_at)}</td>
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatTime(reading.report_time)}</td>
        <td className="px-4 py-3 text-sm font-medium whitespace-nowrap">{reading.device_code || '-'}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.point_name || '-'}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.insname || '-'}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.propertyno || '-'}</td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.paraname}</td>
        <td className="px-4 py-3 text-sm font-semibold text-blue-600 whitespace-nowrap">{reading.value}</td>
        <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs ${reading.quality === 1 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{reading.quality}</span></td>
        <td className="px-4 py-3 text-sm whitespace-nowrap">{reading.project_name || '-'}{reading.project_code && <span className="ml-1 text-xs text-gray-400">({reading.project_code})</span>}</td>
      </tr>)}</tbody>
    </table></div><Pagination total={summary.total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} /></div>
  </div>;
};

const DataReception: React.FC = () => {
  const [tab, setTab] = useState<'water' | 'electrical'>('water');
  return <div className="space-y-5">
    <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-gray-800">数据接收</h2><p className="mt-1 text-sm text-gray-500">接收厂家直传数据，并按点位关联项目写入数据采集库</p></div>
      <div className="flex bg-gray-200/70 p-1 rounded-lg">
        <button onClick={() => setTab('water')} className={`px-4 py-2 rounded-md text-sm font-medium ${tab === 'water' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600'}`}>水表数据</button>
        <button onClick={() => setTab('electrical')} className={`px-4 py-2 rounded-md text-sm font-medium ${tab === 'electrical' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600'}`}>电气数据</button>
      </div>
    </div>
    {tab === 'water' ? <WaterReception /> : <ElectricalReception />}
  </div>;
};

export default DataReception;
