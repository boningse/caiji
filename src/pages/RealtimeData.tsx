import React, { useEffect, useState } from 'react';
import { RefreshCw, Download, FileJson, ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';

interface TelemetryData {
  id: string;
  gateway_sncode: string;
  device_code: string;
  point_name: string;
  insname?: string;
  propertyno?: string;
  paraname?: string;
  quality: number;
  value: string;
  ts: string;
  project_code?: string;
  project_name?: string;
}

interface RawMqttLog {
  id: string;
  gateway_sncode: string;
  topic: string;
  payload: any;
  received_at: string;
}

const RealtimeData: React.FC = () => {
  const [data, setData] = useState<TelemetryData[]>([]);
  const [rawLogs, setRawLogs] = useState<RawMqttLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'parsed' | 'raw'>('parsed');
  
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const [searchQuery, setSearchQuery] = useState('');
  const [secondaryQuery, setSecondaryQuery] = useState('');

  const [totalData, setTotalData] = useState(0);
  const [totalRawLogs, setTotalRawLogs] = useState(0);

  const [startDate, setStartDate] = useState<string>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [endDate, setEndDate] = useState<string>(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setCurrentPage(1);
  }, [viewMode, searchQuery, secondaryQuery, startDate, endDate]);

  const fetchData = () => {
    setLoading(true);
    const headers: Record<string, string> = { 'Authorization': `Bearer ${localStorage.getItem('token') || ''}` };

    const telemetryParams = new URLSearchParams();
    if (startDate) telemetryParams.append('startDate', startDate);
    if (endDate) telemetryParams.append('endDate', endDate);
    telemetryParams.append('page', String(currentPage));
    telemetryParams.append('pageSize', String(pageSize));
    if (searchQuery) telemetryParams.append('search', searchQuery);
    if (secondaryQuery) telemetryParams.append('secondarySearch', secondaryQuery);
    fetch(`/api/gateways/telemetry?${telemetryParams.toString()}`, { headers })
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          setData(res.data);
          setTotalData(res.total !== undefined ? res.total : res.data.length);
        }
      })
      .catch(err => console.error('Error fetching telemetry:', err));

    const rawParams = new URLSearchParams();
    if (startDate) rawParams.append('startDate', startDate);
    if (endDate) rawParams.append('endDate', endDate);
    rawParams.append('page', String(currentPage));
    rawParams.append('pageSize', String(pageSize));
    if (searchQuery) rawParams.append('search', searchQuery);
    fetch(`/api/gateways/raw-logs?${rawParams.toString()}`, { headers })
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          setRawLogs(res.data);
          setTotalRawLogs(res.total !== undefined ? res.total : res.data.length);
        }
      })
      .catch(err => console.error('Error fetching raw logs:', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [currentPage, pageSize, startDate, endDate, searchQuery, secondaryQuery]);

  const toggleSortOrder = () => {
    setSortOrder(prev => (prev === 'desc' ? 'asc' : 'desc'));
  };

  // 如果后端返回了完整数据（未分页），则在前端进行切片；否则直接使用后端分页后的数据
  const paginatedData = data.length > pageSize 
    ? data.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : data;
    
  const paginatedRawLogs = rawLogs.length > pageSize
    ? rawLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    : rawLogs;

  const totalPages = viewMode === 'parsed' 
    ? Math.ceil(totalData / pageSize) || 1
    : Math.ceil(totalRawLogs / pageSize) || 1;

  const currentTotal = viewMode === 'parsed' ? totalData : totalRawLogs;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:gap-3 gap-2">
          <h2 className="text-xl font-semibold text-gray-800">实时数据</h2>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm w-full sm:w-auto"
              aria-label="开始时间"
            />
            <span className="text-gray-400 hidden sm:block">—</span>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm w-full sm:w-auto"
              aria-label="结束时间"
            />
            <button 
              onClick={fetchData}
              className="px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 text-sm w-full sm:w-auto"
            >
              载入
            </button>
          </div>
        </div>
        
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex bg-gray-100 p-1 rounded-lg w-full lg:w-auto">
            <button
              onClick={() => setViewMode('parsed')}
              className={`flex-1 lg:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all ${
                viewMode === 'parsed' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              解析后数据
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`flex-1 lg:flex-none px-4 py-2 text-sm font-medium rounded-md transition-all flex items-center justify-center space-x-1 ${
                viewMode === 'raw' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <FileJson className="w-4 h-4" />
              <span>原始报文日志</span>
            </button>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-2 w-full">
            <input 
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="筛选：网关SN / 项目编号 / 项目名称"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            />
            <input 
              type="text"
              value={secondaryQuery}
              onChange={(e) => setSecondaryQuery(e.target.value)}
              placeholder="二次筛选：实体编号 / 点位名称"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            />
          </div>

          <div className="flex gap-2 w-full lg:w-auto">
            <button 
              onClick={fetchData}
              className="flex-1 lg:flex-none bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg flex items-center justify-center gap-1.5 text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>刷新</span>
            </button>
            <button className="flex-1 lg:flex-none bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center justify-center gap-1.5 text-sm">
              <Download className="w-4 h-4" />
              <span>导出数据</span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'parsed' ? (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th 
                    className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={toggleSortOrder}
                  >
                    <div className="flex items-center space-x-1">
                      <span>时间</span>
                      {sortOrder === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
                    </div>
                  </th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">网关SN</th>
                  <th className="hidden sm:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">项目编号</th>
                  <th className="hidden md:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">项目名称</th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">点位名称</th>
                  <th className="hidden lg:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">实体编号</th>
                  <th className="hidden lg:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">属性列</th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">数值</th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">质量</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedData.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 lg:px-6 py-4 text-center text-gray-500">
                      暂无实时数据
                    </td>
                  </tr>
                ) : (
                  paginatedData.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(row.ts).toLocaleString()}
                      </td>
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{row.gateway_sncode}</td>
                      <td className="hidden sm:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {row.project_code ? (
                          <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded-md text-xs">{row.project_code}</span>
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                      <td className="hidden md:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.project_name || '-'}</td>
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-700 font-medium">{row.point_name || '-'}</td>
                      <td className="hidden lg:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.insname || '-'}</td>
                      <td className="hidden lg:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.propertyno || '-'}</td>
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-bold text-blue-600">{row.value}</td>
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          row.quality === 1 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {row.quality === 1 ? 'Good' : 'Bad'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th 
                    className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={toggleSortOrder}
                  >
                    <div className="flex items-center space-x-1">
                      <span>接收时间</span>
                      {sortOrder === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
                    </div>
                  </th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">网关SN</th>
                  <th className="hidden sm:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">MQTT主题</th>
                  <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">原始JSON报文</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedRawLogs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 lg:px-6 py-8 text-center text-gray-500">
                      暂无原始报文日志
                    </td>
                  </tr>
                ) : (
                  paginatedRawLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(log.received_at).toLocaleString()}
                      </td>
                      <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {log.gateway_sncode || '-'}
                      </td>
                      <td className="hidden sm:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                        {log.topic}
                      </td>
                      <td className="px-4 lg:px-6 py-4 text-sm text-gray-500">
                        <pre className="bg-gray-50 p-3 rounded-lg overflow-x-auto text-xs border border-gray-100 max-h-48 overflow-y-auto">
                          {JSON.stringify(log.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination Controls */}
      <div className="px-4 lg:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-gray-200 bg-white rounded-xl shadow-sm mt-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 w-full sm:w-auto">
          <p className="text-sm text-gray-700">
            显示第 <span className="font-medium">{currentTotal === 0 ? 0 : (currentPage - 1) * pageSize + 1}</span> 到 <span className="font-medium">{Math.min(currentPage * pageSize, currentTotal)}</span> 条结果，共 <span className="font-medium">{currentTotal}</span> 条
          </p>
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-700">每页显示</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 p-1.5 outline-none border"
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
            <span className="text-sm text-gray-700">条</span>
          </div>
        </div>
        <div className="flex items-center space-x-2 sm:space-x-4 w-full sm:w-auto justify-end">
          <button
            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
            disabled={currentPage === 1}
            className="relative inline-flex items-center px-3 py-2 rounded-l-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            上一页
          </button>
          <span className="relative inline-flex items-center px-4 py-2 border-y border-gray-300 bg-white text-sm font-medium text-gray-700">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
            disabled={currentPage === totalPages}
            className="relative inline-flex items-center px-3 py-2 rounded-r-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            下一页
            <ChevronRight className="h-4 w-4 ml-1" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default RealtimeData;
