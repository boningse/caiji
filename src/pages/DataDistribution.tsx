import React, { useEffect, useState } from 'react';
import { Send, Plus, Edit2, Trash2, CheckCircle2, AlertCircle, Database, Play, Square } from 'lucide-react';

interface Distribution {
  id: string;
  name: string;
  project_ids: number[];
  source_data_info: string;
  target_db_type: string;
  target_db_config: any;
  status: string;
  start_time: string;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
  level: number;
  children: Project[];
}

const DataDistribution: React.FC = () => {
  const [distributions, setDistributions] = useState<Distribution[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isReplayModalOpen, setIsReplayModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replayData, setReplayData] = useState({ id: '', name: '', start: '', end: '' });
  const [isReplaying, setIsReplaying] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    project_ids: [] as number[],
    source_data_info: '',
    target_db_type: 'mysql',
    target_db_config: '{}',
    status: 'ACTIVE',
    start_time: ''
  });

  useEffect(() => {
    fetchDistributions();
    fetchProjects();
  }, []);

  const fetchDistributions = () => {
    fetch('/api/distributions', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(res => res.json())
      .then(res => { if (res.success) setDistributions(res.data); })
      .catch(console.error);
  };

  const fetchProjects = () => {
    fetch('/api/projects', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(res => res.json())
      .then(res => { if (res.success) setProjects(res.data); })
      .catch(console.error);
  };

  const flattenProjects = (list: Project[], depth = 0): {id: number, name: string, depth: number, level: number}[] => {
    let result: {id: number, name: string, depth: number, level: number}[] = [];
    list.forEach(p => {
      result.push({ id: parseInt(p.id, 10), name: p.name, depth, level: p.level });
      if (p.children && p.children.length > 0) {
        result = result.concat(flattenProjects(p.children, depth + 1));
      }
    });
    return result;
  };
  const flatProjects = flattenProjects(projects);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return alert('请输入分发进程名称');
    if (formData.project_ids.length === 0) return alert('请至少选择一个关联项目');

    let parsedConfig = {};
    try {
      parsedConfig = JSON.parse(formData.target_db_config);
    } catch (e) {
      return alert('对方数据库设置信息必须是有效的 JSON 格式');
    }

    const payload: any = {
      ...formData,
      target_db_config: parsedConfig
    };
    if (formData.start_time) {
      const dt = new Date(formData.start_time);
      if (!isNaN(dt.getTime())) {
        payload.start_time = dt.toISOString();
      }
    } else {
      payload.start_time = null;
    }
    
    // 如果是新建，且状态为ACTIVE，直接设置当前时间为开始时间可以由后端处理
    // 但是这里只传前端表单数据

    try {
      const url = editingId ? `/api/distributions/${editingId}` : '/api/distributions';
      const method = editingId ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (result.success) {
        setIsModalOpen(false);
        setEditingId(null);
        setFormData({
          name: '',
          project_ids: [],
          source_data_info: '',
          target_db_type: 'mysql',
          target_db_config: '{}',
          status: 'ACTIVE',
          start_time: ''
        });
        fetchDistributions();
      } else {
        alert(result.error);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleEdit = (dist: Distribution) => {
    setEditingId(dist.id);
    setFormData({
      name: dist.name,
      project_ids: dist.project_ids || [],
      source_data_info: dist.source_data_info || '',
      target_db_type: dist.target_db_type || 'mysql',
      target_db_config: JSON.stringify(dist.target_db_config, null, 2) || '{}',
      status: dist.status || 'ACTIVE',
      start_time: dist.start_time ? new Date(dist.start_time).toISOString().slice(0,16) : ''
    });
    setIsModalOpen(true);
  };

  const toggleStatus = async (dist: Distribution) => {
    const newStatus = dist.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const actionText = newStatus === 'ACTIVE' ? '启动' : '停止';
    
    if (!confirm(`确定要${actionText}该分发进程吗？`)) return;
    
    try {
      const res = await fetch(`/api/distributions/${dist.id}/status`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      const result = await res.json();
      if (result.success) {
        fetchDistributions();
      } else {
        alert(result.error || `操作失败`);
      }
    } catch (e) {
      console.error(e);
      alert('网络错误，操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除该分发进程吗？')) return;
    try {
      const res = await fetch(`/api/distributions/${id}`, { 
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const result = await res.json();
      if (result.success) fetchDistributions();
    } catch (e) {
      console.error(e);
    }
  };

  const handleReplayClick = (dist: Distribution) => {
    setReplayData({
      id: dist.id,
      name: dist.name,
      start: '',
      end: ''
    });
    setIsReplayModalOpen(true);
  };

  const handleReplaySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replayData.start) return alert('请选择开始时间');
    
    if (!confirm(`确定要为进程 [${replayData.name}] 触发历史数据补发吗？\n注意：此操作将在后台异步执行。`)) return;
    
    setIsReplaying(true);
    try {
      const res = await fetch(`/api/distributions/${replayData.id}/replay`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ start: new Date(replayData.start).toISOString(), end: replayData.end ? new Date(replayData.end).toISOString() : undefined })
      });
      const result = await res.json();
      if (result.success) {
        alert('补发任务已成功下发后台处理！您无需在此页面等待。');
        setIsReplayModalOpen(false);
      } else {
        alert(result.error || '补发请求失败');
      }
    } catch (error) {
      console.error(error);
      alert('网络错误，补发请求失败');
    } finally {
      setIsReplaying(false);
    }
  };

  const getProjectNames = (ids: number[]) => {
    if (!ids || ids.length === 0) return '-';
    return ids.map(id => flatProjects.find(p => p.id === id)?.name || id).join('、');
  };

  const dbTypes = [
    { value: 'mysql', label: 'MySQL' },
    { value: 'postgresql', label: 'PostgreSQL' },
    { value: 'mqtt', label: 'MQTT' },
    { value: 'api', label: 'REST API' }
  ];

  const handleProjectToggle = (projectId: number) => {
    setFormData(prev => ({
      ...prev,
      project_ids: prev.project_ids.includes(projectId)
        ? prev.project_ids.filter(id => id !== projectId)
        : [...prev.project_ids, projectId]
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-start gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">数据分发</h2>
          <p className="text-sm text-gray-500 mt-1">配置数据分发进程，将采集到的数据推送至第三方数据库或接口</p>
        </div>
        <button 
          onClick={() => {
            setEditingId(null);
            setFormData({
              name: '',
              project_ids: [],
              source_data_info: '',
              target_db_type: 'mysql',
              target_db_config: '{\n  "host": "",\n  "port": 3306,\n  "user": "",\n  "password": "",\n  "database": ""\n}',
              status: 'ACTIVE',
              start_time: ''
            });
            setIsModalOpen(true);
          }}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center justify-center space-x-2 transition-colors shadow-sm w-full lg:w-auto"
        >
          <Plus className="w-4 h-4" />
          <span>新建分发进程</span>
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">进程名称</th>
                <th className="hidden sm:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">关联项目</th>
                <th className="hidden md:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">目标类型</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {distributions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 lg:px-6 py-8 text-center text-gray-500">
                    <Send className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p>暂无数据分发进程，请点击右上角新建</p>
                  </td>
                </tr>
              ) : (
                distributions.map((dist) => (
                  <tr key={dist.id} className="hover:bg-gray-50">
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{dist.name}</td>
                    <td className="hidden sm:table-cell px-4 lg:px-6 py-4 text-sm text-gray-500 max-w-[200px] truncate" title={getProjectNames(dist.project_ids)}>
                      {getProjectNames(dist.project_ids)}
                    </td>
                    <td className="hidden md:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <span className="flex items-center space-x-1">
                        <Database className="w-4 h-4 text-gray-400" />
                        <span>{dbTypes.find(t => t.value === dist.target_db_type)?.label || dist.target_db_type}</span>
                      </span>
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${dist.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                        {dist.status === 'ACTIVE' ? '运行中' : '已停止'}
                      </span>
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <button
                        onClick={() => handleReplayClick(dist)}
                        className="text-indigo-600 hover:text-indigo-900 mr-2 transition-colors p-1"
                        title="历史数据全量补发"
                      >
                        <Database className="w-5 h-5 inline-block" />
                      </button>
                      {dist.status === 'ACTIVE' ? (
                        <button
                          onClick={() => toggleStatus(dist)}
                          className="text-orange-600 hover:text-orange-900 mr-2 transition-colors p-1"
                          title="停止分发"
                        >
                          <Square className="w-5 h-5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleStatus(dist)}
                          className="text-green-600 hover:text-green-900 mr-2 transition-colors p-1"
                          title="启动分发"
                        >
                          <Play className="w-5 h-5" />
                        </button>
                      )}
                      <button
                        onClick={() => handleEdit(dist)}
                        className="text-blue-600 hover:text-blue-900 mr-2 transition-colors p-1"
                        title="编辑配置"
                      >
                        <Edit2 className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => handleDelete(dist.id)}
                        className="text-red-600 hover:text-red-900 transition-colors p-1"
                        title="删除进程"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-800">{editingId ? '编辑分发进程' : '新建分发进程'}</h3>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100 transition-colors"
              >
                <span className="text-2xl leading-none">&times;</span>
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="p-6 space-y-4 flex-1 overflow-y-auto">
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      进程名称 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder="如: 推送至中心库"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                      required
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      关联项目 (可多选) <span className="text-red-500">*</span>
                    </label>
                    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 max-h-48 overflow-y-auto">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                        {flatProjects.map(project => (
                          <label key={project.id} className="flex items-center space-x-3 p-2 bg-white border border-gray-100 rounded-lg cursor-pointer hover:border-blue-300">
                            <input 
                              type="checkbox"
                              checked={formData.project_ids.includes(project.id)}
                              onChange={() => handleProjectToggle(project.id)}
                              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700 font-medium truncate" title={project.name}>
                              {'\u00A0'.repeat(project.depth * 2)}{project.name}
                            </span>
                          </label>
                        ))}
                        {flatProjects.length === 0 && (
                          <div className="col-span-full text-center text-gray-400 py-4">
                            暂无可选项目，请先在“项目管理”中添加
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    配置数据信息 (可选)
                  </label>
                  <p className="text-xs text-gray-500 mb-2">描述需要分发的具体数据范围或条件</p>
                  <textarea
                    value={formData.source_data_info}
                    onChange={e => setFormData({ ...formData, source_data_info: e.target.value })}
                    placeholder="例如: 仅分发温度和湿度数据..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none h-20 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      目标数据库类型 <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.target_db_type}
                      onChange={e => {
                        const type = e.target.value;
                        setFormData({ ...formData, target_db_type: type });
                        if (type === 'mqtt' && formData.target_db_config.includes('host')) {
                          setFormData(prev => ({...prev, target_db_config: '{\n  "broker_url": "mqtt://",\n  "username": "",\n  "password": "",\n  "topic": ""\n}'}));
                        } else if (type === 'api' && formData.target_db_config.includes('host')) {
                          setFormData(prev => ({...prev, target_db_config: '{\n  "url": "http://",\n  "method": "POST",\n  "headers": {}\n}'}));
                        } else if ((type === 'mysql' || type === 'postgresql') && !formData.target_db_config.includes('host')) {
                          setFormData(prev => ({...prev, target_db_config: '{\n  "host": "",\n  "port": 3306,\n  "user": "",\n  "password": "",\n  "database": ""\n}'}));
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      {dbTypes.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      状态
                    </label>
                    <select
                      value={formData.status}
                      onChange={e => setFormData({ ...formData, status: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="ACTIVE">运行中</option>
                      <option value="INACTIVE">已停止</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    对方数据库设置信息 (JSON) <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={formData.target_db_config}
                    onChange={e => setFormData({ ...formData, target_db_config: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm h-40"
                    required
                  />
                </div>
              </div>

              <div className="p-6 bg-gray-50 border-t border-gray-200 flex justify-end space-x-4 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-6 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg shadow-sm transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-colors"
                >
                  保存配置
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 历史数据全量补发弹窗 */}
      {isReplayModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-800">历史数据全量补发</h3>
              <button 
                onClick={() => setIsReplayModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100 transition-colors"
              >
                <span className="text-2xl leading-none">&times;</span>
              </button>
            </div>
            
            <form onSubmit={handleReplaySubmit} className="flex flex-col flex-1">
              <div className="p-6 space-y-4">
                <div className="bg-blue-50 text-blue-800 p-3 rounded-lg text-sm mb-2">
                  正在为进程 <strong>{replayData.name}</strong> 补发历史数据。此操作将扫描并提取底层数据库中的历史原始数据并向目标库推送。
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    补发开始时间 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={replayData.start}
                    onChange={e => setReplayData({ ...replayData, start: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    required
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    补发结束时间 (可选)
                  </label>
                  <input
                    type="datetime-local"
                    value={replayData.end}
                    onChange={e => setReplayData({ ...replayData, end: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">留空则默认补发至当前最新时间。</p>
                </div>
              </div>

              <div className="p-6 bg-gray-50 border-t border-gray-200 flex justify-end space-x-4 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setIsReplayModalOpen(false)}
                  className="px-6 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg shadow-sm transition-colors"
                  disabled={isReplaying}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors flex items-center"
                  disabled={isReplaying}
                >
                  {isReplaying ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      处理中...
                    </>
                  ) : (
                    '开始补发'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataDistribution;
