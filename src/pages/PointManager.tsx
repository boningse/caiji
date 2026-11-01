import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Edit2, Trash2, Download, Upload, FileSpreadsheet } from 'lucide-react';

interface Project {
  id: string;
  name: string;
  level: number;
  children: Project[];
}

interface PointItem {
  id: string;
  project_id: number;
  project_name?: string;
  project_code?: string;
  name: string;
  insname?: string;
  propertyno?: string;
  device_code?: string;
  gateway_sncode?: string;
  status: string;
  created_at: string;
}

const API = (url: string, options?: RequestInit) =>
  fetch(url, {
    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}`, ...(options?.headers || {}) },
    ...options,
  }).then(r => r.json());

const PointManager: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [points, setPoints] = useState<PointItem[]>([]);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [total, setTotal] = useState<number>(0);
  const reqIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [editing, setEditing] = useState<PointItem | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importProjectId, setImportProjectId] = useState<string>('');
  const [exportProjectId, setExportProjectId] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null);
  const [formData, setFormData] = useState({
    name: '', insname: '', propertyno: '', device_code: '', gateway_sncode: '', status: 'ACTIVE'
  });
  const [formProjectId, setFormProjectId] = useState<string>('');

  useEffect(() => {
    API('/api/projects').then(r => { if (r.success) setProjects(r.data); });
    const last = localStorage.getItem('pointmgr_selected_project');
    if (last) setSelectedProject(last);
  }, []);

  useEffect(() => { loadPoints(selectedProject || undefined); }, [selectedProject]);

  useEffect(() => {
    const handler = setTimeout(() => { setCurrentPage(1); loadPoints(selectedProject || undefined, 1, pageSize, filterQuery); }, 300);
    return () => clearTimeout(handler);
  }, [filterQuery]);

  const flattenProjects = (list: Project[], depth = 0): { id: number; name: string; depth: number }[] => {
    let res: any[] = [];
    list.forEach(p => {
      res.push({ id: parseInt(p.id, 10), name: p.name, depth });
      if (p.children?.length) res = res.concat(flattenProjects(p.children, depth + 1));
    });
    return res;
  };
  const flatProjects = useMemo(() => flattenProjects(projects), [projects]);

  const loadPoints = (pid?: string, page = currentPage, size = pageSize, q = filterQuery) => {
    const reqId = ++reqIdRef.current;
    const params = new URLSearchParams();
    const hasQ = !!(q && q.trim());
    if (pid) params.append('project_id', pid);
    params.append('page', String(page));
    params.append('pageSize', String(size));
    if (hasQ) params.append('q', q.trim());
    API(`/api/points?${params.toString()}`).then(r => {
      if (reqId !== reqIdRef.current) return;
      if (r.success) { setPoints(r.data); if (r.pagination) { setTotal(r.pagination.total || 0); setCurrentPage(r.pagination.page || 1); } }
    });
  };

  const selectProject = (pid: string) => {
    setSelectedProject(pid);
    localStorage.setItem('pointmgr_selected_project', pid);
    setCurrentPage(1);
    loadPoints(pid, 1, pageSize);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formProjectId) return alert('请选择项目');
    if (!formData.name) return alert('请输入点位名称');
    const body = { ...formData, project_id: parseInt(formProjectId, 10) };
    const url = editing ? `/api/points/${editing.id}` : '/api/points';
    const method = editing ? 'PUT' : 'POST';
    const result = await API(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (result.success) {
      setIsModalOpen(false); setEditing(null);
      setFormData({ name: '', insname: '', propertyno: '', device_code: '', gateway_sncode: '', status: 'ACTIVE' });
      if (selectedProject === String(body.project_id)) loadPoints(selectedProject);
      else { selectProject(String(body.project_id)); }
    } else { alert(result.error || '保存失败'); }
  };

  const editPoint = (pt: PointItem) => {
    setEditing(pt);
    setFormData({ name: pt.name, insname: pt.insname || '', propertyno: pt.propertyno || '', device_code: pt.device_code || '', gateway_sncode: pt.gateway_sncode || '', status: pt.status });
    setFormProjectId(String(pt.project_id));
    setIsModalOpen(true);
  };

  const deletePoint = async (id: string) => {
    if (!confirm('确定要删除这个点位吗？')) return;
    const result = await API(`/api/points/${id}`, { method: 'DELETE' });
    if (result.success) loadPoints(selectedProject);
    else alert(result.error || '删除失败');
  };

  const deleteAll = async () => {
    if (!selectedProject) return alert('请先选择一个项目');
    const proj = flatProjects.find(p => p.id === parseInt(selectedProject, 10));
    if (!confirm(`确定要删除项目「${proj?.name || selectedProject}」下的全部点位吗？此操作不可恢复。`)) return;
    const result = await API(`/api/points/by-project/${selectedProject}`, { method: 'DELETE' });
    if (result.success) { alert(`已删除 ${result.data.deleted} 个点位`); loadPoints(selectedProject); }
    else alert(result.error || '删除失败');
  };

  // Export Excel - direct download
  const handleExport = async () => {
    if (!exportProjectId) return alert('请选择要导出的项目');
    try {
      const resp = await fetch(`/api/points/export?project_id=${exportProjectId}`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (!resp.ok) { const err = await resp.json(); alert(err.error || '导出失败'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '点位列表.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      setIsExportOpen(false);
      setExportProjectId('');
    } catch (err) { alert('导出失败'); }
  };

  // Download template
  const handleTemplate = async () => {
    try {
      const resp = await fetch('/api/points/template', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (!resp.ok) { const err = await resp.json(); alert(err.error || '下载失败'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '点位导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert('模板下载失败'); }
  };

  // Import Excel
  const handleImport = async () => {
    if (!importFile) return alert('请选择 Excel 文件');
    if (!importProjectId) return alert('请选择目标项目');
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', importFile);
      formData.append('project_id', importProjectId);
      const resp = await fetch('/api/points/bulk-xlsx', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: formData,
      });
      const result = await resp.json();
      if (result.success) {
        setImportResult(result.data);
        setImportFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        loadPoints(importProjectId);
      } else {
        alert(result.error || '导入失败');
      }
    } catch (err) {
      alert('导入请求失败');
    } finally {
      setImporting(false);
    }
  };

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div className="p-6 max-w-full mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-bold text-gray-800">点位管理</h1>
        <div className="flex-1" />
        <button onClick={handleTemplate} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
          <FileSpreadsheet size={16} /> 下载导入模板
        </button>
        <button onClick={() => setIsImportOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm">
          <Upload size={16} /> Excel 导入
        </button>
        <button onClick={() => setIsExportOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
          <Download size={16} /> Excel 导出
        </button>
        <button onClick={() => { setEditing(null); setFormData({ name: '', insname: '', propertyno: '', device_code: '', gateway_sncode: '', status: 'ACTIVE' }); setIsModalOpen(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
          <Plus size={16} /> 新增点位
        </button>
        <button onClick={deleteAll} className="px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm flex items-center gap-2">
          <Trash2 size={16} /> 删除全部
        </button>
      </div>

      {/* Filter & Project Select */}
      <div className="flex flex-wrap gap-4 items-center">
        <select value={selectedProject} onChange={(e) => selectProject(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm min-w-[200px]">
          <option value="">全部项目</option>
          {flatProjects.map(p => (<option key={p.id} value={p.id}>{'\u00A0'.repeat(p.depth * 2)}{p.name}</option>))}
        </select>
        <input value={filterQuery} onChange={e => setFilterQuery(e.target.value)} placeholder="搜索 点位名称 / insname / propertyno ..." className="flex-1 min-w-[250px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
            <tr>
              <th className="px-4 py-3 font-medium">点位名称</th>
              <th className="px-4 py-3 font-medium">insname</th>
              <th className="px-4 py-3 font-medium">propertyno</th>
              <th className="px-4 py-3 font-medium">设备地址</th>
              <th className="px-4 py-3 font-medium">网关SN</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">所属项目</th>
              <th className="px-4 py-3 font-medium">创建时间</th>
              <th className="px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {points.map(pt => (
              <tr key={pt.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-medium text-gray-800">{pt.name}</td>
                <td className="px-4 py-3 text-gray-500">{pt.insname || '-'}</td>
                <td className="px-4 py-3 text-gray-500">{pt.propertyno || '-'}</td>
                <td className="px-4 py-3 text-gray-500">{pt.device_code || '-'}</td>
                <td className="px-4 py-3 text-gray-500">{pt.gateway_sncode || '-'}</td>
                <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${pt.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{pt.status}</span></td>
                <td className="px-4 py-3 text-gray-500">{pt.project_name || '-'}</td>
                <td className="px-4 py-3 text-gray-400 text-xs">{new Date(pt.created_at).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => editPoint(pt)} className="p-1.5 rounded hover:bg-blue-50 text-blue-600"><Edit2 size={15} /></button>
                    <button onClick={() => deletePoint(pt.id)} className="p-1.5 rounded hover:bg-red-50 text-red-500"><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {points.length === 0 && (<tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">暂无数据</td></tr>)}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center text-sm text-gray-600">
          <div>共 {total} 条</div>
          <div className="flex gap-2">
            <button onClick={() => loadPoints(selectedProject, currentPage - 1)} disabled={currentPage <= 1} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">上一页</button>
            <span className="px-3 py-1">{currentPage} / {totalPages}</span>
            <button onClick={() => loadPoints(selectedProject, currentPage + 1)} disabled={currentPage >= totalPages} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">下一页</button>
          </div>
        </div>
      )}

      {/* Add / Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-800">{editing ? '编辑点位' : '新增点位'}</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"><span className="text-2xl leading-none">&times;</span></button>
            </div>
            <form onSubmit={submit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">选择项目 <span className="text-red-500">*</span></label>
                <select value={formProjectId} onChange={(e) => setFormProjectId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" required>
                  <option value="">— 请选择项目 —</option>
                  {flatProjects.map(p => (<option key={`modal-${p.id}`} value={p.id}>{'\u00A0'.repeat(p.depth * 2)}{p.name}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">点位名称 <span className="text-red-500">*</span></label>
                <input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" placeholder="例如：进水温度、出水压力" required />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-gray-700 mb-1">insname</label><input value={formData.insname} onChange={e => setFormData({ ...formData, insname: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">propertyno</label><input value={formData.propertyno} onChange={e => setFormData({ ...formData, propertyno: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" /></div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-gray-700 mb-1">设备地址 device_code</label><input value={formData.device_code} onChange={e => setFormData({ ...formData, device_code: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">网关 SN</label><input value={formData.gateway_sncode} onChange={e => setFormData({ ...formData, gateway_sncode: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" /></div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">状态</label>
                <select value={formData.status} onChange={e => setFormData({ ...formData, status: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div className="flex justify-end space-x-3 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-6 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
                <button type="submit" className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {isExportOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">导出点位</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">选择要导出的项目</label>
            <select value={exportProjectId} onChange={(e) => setExportProjectId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-4">
              <option value="">— 请选择项目 —</option>
              {flatProjects.map(p => (<option key={`exp-${p.id}`} value={p.id}>{'\u00A0'.repeat(p.depth * 2)}{p.name}</option>))}
            </select>
            <div className="flex justify-end space-x-3">
              <button onClick={() => { setIsExportOpen(false); setExportProjectId(''); }} className="px-6 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
              <button onClick={handleExport} disabled={!exportProjectId} className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40">下载 Excel</button>
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {isImportOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">Excel 批量导入点位</h3>

            <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
              <p className="font-medium mb-1">导入说明：</p>
              <ul className="list-disc pl-4 space-y-0.5 text-xs">
                <li>请先<button onClick={handleTemplate} className="text-blue-600 underline mx-1">下载导入模板</button>，按模板格式填写</li>
                <li>表头字段必须与模板一致（中文），点位名称为必填</li>
                <li>如 insname 已存在，将更新该条记录；否则新增</li>
                <li>单次最大文件 10MB</li>
              </ul>
            </div>

            <label className="block text-sm font-medium text-gray-700 mb-1">选择目标项目 <span className="text-red-500">*</span></label>
            <select value={importProjectId} onChange={(e) => setImportProjectId(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-4">
              <option value="">— 请选择项目 —</option>
              {flatProjects.map(p => (<option key={`imp-${p.id}`} value={p.id}>{'\u00A0'.repeat(p.depth * 2)}{p.name}</option>))}
            </select>

            <label className="block text-sm font-medium text-gray-700 mb-1">上传 Excel 文件 <span className="text-red-500">*</span></label>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={(e) => setImportFile(e.target.files?.[0] || null)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-4 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 file:text-sm hover:file:bg-blue-100" />

            {importResult && (
              <div className={`mb-4 p-3 rounded-lg text-sm ${importResult.failed > 0 ? 'bg-orange-50 border border-orange-200 text-orange-800' : 'bg-green-50 border border-green-200 text-green-800'}`}>
                <p className="font-medium">导入完成：成功 {importResult.success} 条{importResult.failed > 0 ? `，失败 ${importResult.failed} 条` : ''}</p>
                {importResult.errors?.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs space-y-0.5 max-h-32 overflow-y-auto">
                    {importResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-3">
              <button onClick={() => { setIsImportOpen(false); setImportFile(null); setImportResult(null); setImportProjectId(''); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="px-6 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
              <button onClick={handleImport} disabled={!importFile || !importProjectId || importing} className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                {importing ? '导入中...' : '开始导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PointManager;
