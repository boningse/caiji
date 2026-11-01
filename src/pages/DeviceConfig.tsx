import React, { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, X, ChevronLeft, ChevronRight, Activity } from 'lucide-react';
import MqttDebugModal from '../components/MqttDebugModal';

interface Gateway {
  sncode: string;
  alias: string;
  ip_address: string;
  project_id: number | null;
  project_name?: string;
  project_ids?: number[];
  associated_project_ids?: number[];
  associated_projects?: Array<{ id: number; name: string; level: number }>;
  publish_topic?: string;
  subscribe_topic?: string;
  status: string;
  last_offline_time?: string | null;
  created_at: string;
}

interface Project {
  id: string;
  code: string;
  name: string;
  details: string;
  level: number;
  children: Project[];
}

const formatDateTime = (value?: string | null) => value
  ? new Date(value).toLocaleString('zh-CN', { hour12: false })
  : '-';

const DeviceConfig: React.FC = () => {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  
  // 分级筛选状态
  const [filterLevel1, setFilterLevel1] = useState<string>('全部');
  const [filterLevel2, setFilterLevel2] = useState<string>('全部');
  const [filterLevel3, setFilterLevel3] = useState<string>('全部');

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [formData, setFormData] = useState({
    sncode: '',
    alias: '',
    ip_address: '',
    project_id: '',
    associated_project_ids: [] as string[],
    publish_topic: '',
    subscribe_topic: ''
  });
  const [loading, setLoading] = useState(false);
  const [debugGateway, setDebugGateway] = useState<Gateway | null>(null);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const fetchGateways = () => {
    fetch('/api/gateways')
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          setGateways(res.data);
        }
      })
      .catch(err => console.error('Error fetching gateways:', err));
  };

  const fetchProjects = () => {
    fetch('/api/projects')
      .then(res => res.json())
      .then(res => {
        if (res.success) {
          setProjects(res.data);
        }
      })
      .catch(err => console.error('Error fetching projects:', err));
  };

  useEffect(() => {
    fetchGateways();
    fetchProjects();
  }, []);

  // Reset to first page when search or filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterLevel1, filterLevel2, filterLevel3]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.sncode || !formData.alias || !formData.project_id) {
      alert('SN号、网关别名和主项目不能为空！');
      return;
    }
    
    setLoading(true);
    try {
      const url = isEditMode ? `/api/gateways/${formData.sncode}` : '/api/gateways';
      const method = isEditMode ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });
      
      const result = await response.json();
      if (result.success) {
        setIsModalOpen(false);
        setFormData({ sncode: '', alias: '', ip_address: '', project_id: '', associated_project_ids: [], publish_topic: '', subscribe_topic: '' });
        setIsEditMode(false);
        fetchGateways(); // Refresh the list
      } else {
        alert(result.error || (isEditMode ? '修改失败' : '添加失败'));
      }
    } catch (error) {
      console.error('Error saving gateway:', error);
      alert(isEditMode ? '修改网关时发生错误' : '添加网关时发生错误');
    } finally {
      setLoading(false);
    }
  };

  const handleEditClick = (gw: Gateway) => {
    setFormData({
      sncode: gw.sncode,
      alias: gw.alias,
      ip_address: gw.ip_address || '',
      project_id: gw.project_id ? gw.project_id.toString() : '',
      associated_project_ids: (gw.associated_project_ids || []).map(String),
      publish_topic: gw.publish_topic || '',
      subscribe_topic: gw.subscribe_topic || ''
    });
    setIsEditMode(true);
    setIsModalOpen(true);
  };

  const handleAddClick = () => {
    setFormData({ sncode: '', alias: '', ip_address: '', project_id: '', associated_project_ids: [], publish_topic: '', subscribe_topic: '' });
    setIsEditMode(false);
    setIsModalOpen(true);
  };

  // 提取三级项目的下拉框数据
  const level1Projects = projects.filter(p => p.level === 1);
  const level2Projects = filterLevel1 !== '全部' 
    ? level1Projects.find(p => p.id === filterLevel1)?.children || [] 
    : [];
  const level3Projects = filterLevel2 !== '全部'
    ? level2Projects.find(p => p.id === filterLevel2)?.children || []
    : [];

  // 递归获取某个项目及其所有子项目的 ID 集合
  const getProjectAndChildrenIds = (projectId: string, projectList: Project[]): string[] => {
    const ids: string[] = [];
    const findNode = (list: Project[]) => {
      for (const p of list) {
        if (p.id === projectId) {
          ids.push(p.id);
          const collectChildren = (children: Project[]) => {
            children.forEach(child => {
              ids.push(child.id);
              if (child.children) collectChildren(child.children);
            });
          };
          if (p.children) collectChildren(p.children);
          return true;
        }
        if (p.children && findNode(p.children)) return true;
      }
      return false;
    };
    findNode(projectList);
    return ids;
  };

  // 将树状项目结构拍平，用于添加/编辑弹窗的下拉框选择
  const flattenProjects = (list: Project[], depth = 0): {id: string, name: string, depth: number, level: number}[] => {
    let result: {id: string, name: string, depth: number, level: number}[] = [];
    list.forEach(p => {
      result.push({ id: p.id, name: p.name, depth, level: p.level });
      if (p.children && p.children.length > 0) {
        result = result.concat(flattenProjects(p.children, depth + 1));
      }
    });
    return result;
  };
  const flatProjects = flattenProjects(projects);
  const selectedRootProject = formData.project_id
    ? projects.find(project => getProjectAndChildrenIds(project.id, projects).includes(formData.project_id))
    : undefined;
  const selectedProjectTreeIds = selectedRootProject
    ? new Set(getProjectAndChildrenIds(selectedRootProject.id, projects))
    : new Set<string>();
  const availableAssociatedProjects = flatProjects.filter(project =>
    project.id !== formData.project_id &&
    (project.level === 2 || project.level === 3) &&
    selectedProjectTreeIds.has(project.id)
  );

  const toggleAssociatedProject = (projectId: string) => {
    setFormData(prev => ({
      ...prev,
      associated_project_ids: prev.associated_project_ids.includes(projectId)
        ? prev.associated_project_ids.filter(id => id !== projectId)
        : [...prev.associated_project_ids, projectId],
    }));
  };

  // 项目被删除后，旧网关可能暂时没有项目。过滤时统一清理空值，
  // 避免 [null] 导致页面报错并让整组筛选失效。
  const getGatewayProjectIds = (gateway: Gateway): string[] => {
    const ids = Array.isArray(gateway.project_ids) ? gateway.project_ids : [];
    const validIds = ids
      .filter((id): id is number => id !== null && id !== undefined && Number.isFinite(Number(id)))
      .map(String);
    if (validIds.length === 0 && gateway.project_id !== null && gateway.project_id !== undefined) {
      return [String(gateway.project_id)];
    }
    return validIds;
  };

  // 根据当前选择的分级项目、SN号和别名进行过滤
  const filteredGateways = gateways.filter(gw => {
    const gatewayProjectIds = getGatewayProjectIds(gw);
    // 1. 项目分级过滤
    let matchProject = true;
    if (filterLevel3 !== '全部') {
      const allowedIds = getProjectAndChildrenIds(filterLevel3, projects);
      matchProject = gatewayProjectIds.some(id => allowedIds.includes(id));
    } else if (filterLevel2 !== '全部') {
      const allowedIds = getProjectAndChildrenIds(filterLevel2, projects);
      matchProject = gatewayProjectIds.some(id => allowedIds.includes(id));
    } else if (filterLevel1 !== '全部') {
      const allowedIds = getProjectAndChildrenIds(filterLevel1, projects);
      matchProject = gatewayProjectIds.some(id => allowedIds.includes(id));
    }
    
    // 2. 搜索词过滤 (支持SN号和别名)
    const matchSearch = searchQuery === '' || 
      gw.sncode.toLowerCase().includes(searchQuery.toLowerCase()) || 
      String(gw.alias || '').toLowerCase().includes(searchQuery.toLowerCase());
      
    return matchProject && matchSearch;
  });

  // Calculate paginated data
  const totalPages = Math.ceil(filteredGateways.length / pageSize) || 1;
  const paginatedGateways = filteredGateways.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-start gap-4">
        <h2 className="text-xl font-semibold text-gray-800">网关列表</h2>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 flex-wrap">
          <input 
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索 SN号 / 网关别名"
            className="flex-1 sm:flex-none sm:w-64 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          />
          <select 
            value={filterLevel1}
            onChange={(e) => {
              setFilterLevel1(e.target.value);
              setFilterLevel2('全部');
              setFilterLevel3('全部');
            }}
            className="flex-1 sm:flex-none px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-700"
          >
            <option value="全部">一级项目(全部)</option>
            {level1Projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select 
            value={filterLevel2}
            onChange={(e) => {
              setFilterLevel2(e.target.value);
              setFilterLevel3('全部');
            }}
            disabled={filterLevel1 === '全部'}
            className="flex-1 sm:flex-none px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-700 disabled:bg-gray-100 disabled:text-gray-400"
          >
            <option value="全部">二级项目(全部)</option>
            {level2Projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select 
            value={filterLevel3}
            onChange={(e) => setFilterLevel3(e.target.value)}
            disabled={filterLevel2 === '全部'}
            className="flex-1 sm:flex-none px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white text-gray-700 disabled:bg-gray-100 disabled:text-gray-400"
          >
            <option value="全部">三级项目(全部)</option>
            {level3Projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button 
            onClick={handleAddClick}
            className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center justify-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>添加网关</span>
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">SN号</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">网关别名</th>
                <th className="hidden sm:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">主项目 / 关联项目</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">离线时间</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedGateways.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 lg:px-6 py-4 text-center text-gray-500">
                    暂无网关数据
                  </td>
                </tr>
              ) : (
                paginatedGateways.map((gw) => (
                  <tr key={gw.sncode} className="hover:bg-gray-50">
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{gw.sncode}</td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">{gw.alias}</td>
                    <td className="hidden sm:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {gw.project_name ? (
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded-md text-xs">主：{gw.project_name}</span>
                          {(gw.associated_projects || []).map(project => (
                            <span key={project.id} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-md text-xs">
                              {project.level}级：{project.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">-</span>
                      )}
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm">
                      <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        gw.status === 'ONLINE' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      }`}>
                        {gw.status}
                      </span>
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-xs text-gray-500">
                      {gw.status === 'OFFLINE' ? formatDateTime(gw.last_offline_time) : '-'}
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500 flex items-center space-x-2">
                      <button 
                        onClick={() => setDebugGateway(gw)}
                        className="text-green-600 hover:text-green-900 p-1"
                        title="MQTT通信调试"
                      >
                        <Activity className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleEditClick(gw)}
                        className="text-blue-600 hover:text-blue-900 p-1"
                        title="编辑"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={async () => {
                          if (confirm(`确定要删除网关 ${gw.sncode} 吗？`)) {
                            try {
                              const res = await fetch(`/api/gateways/${gw.sncode}`, { method: 'DELETE' });
                              const result = await res.json();
                              if (result.success) {
                                fetchGateways();
                              } else {
                                alert('删除失败');
                              }
                            } catch {
                              alert('删除出错');
                            }
                          }
                        }}
                        className="text-red-600 hover:text-red-900 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <div className="px-4 lg:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-gray-200 bg-white">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 w-full sm:w-auto">
            <p className="text-sm text-gray-700">
              显示第 <span className="font-medium">{filteredGateways.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}</span> 到 <span className="font-medium">{Math.min(currentPage * pageSize, filteredGateways.length)}</span> 条结果，共 <span className="font-medium">{filteredGateways.length}</span> 条
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
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
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

      {/* Add Gateway Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-4 lg:p-6 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">
                {isEditMode ? '编辑网关' : '添加新网关'}
              </h3>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1.5 rounded-full"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-4 lg:p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  网关SN号 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="sncode"
                  value={formData.sncode}
                  onChange={handleInputChange}
                  disabled={isEditMode}
                  placeholder="例如: 1312690CC87717F4"
                  className={`w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${
                    isEditMode ? 'bg-gray-100 cursor-not-allowed' : ''
                  }`}
                  required
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  网关别名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="alias"
                  value={formData.alias}
                  onChange={handleInputChange}
                  placeholder="例如: 一号车间主网关"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  发布主题 (下发命令主题)
                </label>
                <input
                  type="text"
                  name="publish_topic"
                  value={formData.publish_topic}
                  onChange={handleInputChange}
                  placeholder="例如: device/control/1312690CC87717F4"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  订阅主题 (上报数据主题)
                </label>
                <input
                  type="text"
                  name="subscribe_topic"
                  value={formData.subscribe_topic}
                  onChange={handleInputChange}
                  placeholder="例如: device/data/1312690CC87717F4"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  主项目 <span className="text-red-500">*</span>
                </label>
                <select
                  name="project_id"
                  value={formData.project_id}
                  onChange={(e) => setFormData(prev => ({ ...prev, project_id: e.target.value, associated_project_ids: [] }))}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all bg-white"
                >
                  <option value="">请选择主项目</option>
                  {flatProjects.map(project => (
                    <option key={project.id} value={project.id}>
                      {'—'.repeat(project.depth)}{project.level}级 · {project.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">一级、二级、三级项目均可作为网关的独立主项目。</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  关联项目
                </label>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                  {!formData.project_id ? (
                    <p className="text-xs text-gray-500">请先选择主项目</p>
                  ) : availableAssociatedProjects.length === 0 ? (
                    <p className="text-xs text-gray-500">同一项目树下暂无其他二级或三级项目</p>
                  ) : availableAssociatedProjects.map(project => (
                    <label key={project.id} className="flex items-center gap-2 rounded-md bg-white px-3 py-2 border border-gray-100 cursor-pointer hover:border-blue-300">
                      <input
                        type="checkbox"
                        checked={formData.associated_project_ids.includes(project.id)}
                        onChange={() => toggleAssociatedProject(project.id)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">
                        {'　'.repeat(Math.max(project.depth - 1, 0))}{project.level}级 · {project.name}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500">可选择同一项目树下的其他二/三级项目；数据会完整复制给主项目和每个关联项目。</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  静态IP地址 (可选)
                </label>
                <input
                  type="text"
                  name="ip_address"
                  value={formData.ip_address}
                  onChange={handleInputChange}
                  placeholder="例如: 192.168.1.100"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                />
              </div>

              <div className="pt-4 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end sm:space-x-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="w-full sm:w-auto px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className={`w-full sm:w-auto px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center justify-center ${
                    loading ? 'opacity-70 cursor-not-allowed' : ''
                  }`}
                >
                  {loading ? '保存中...' : (isEditMode ? '确认修改' : '确认添加')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {debugGateway && (
        <MqttDebugModal
          gateway={debugGateway}
          onClose={() => setDebugGateway(null)}
        />
      )}
    </div>
  );
};

export default DeviceConfig;
