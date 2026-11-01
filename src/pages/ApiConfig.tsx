import React, { useEffect, useState } from 'react';
import { Key, Plus, Copy, Trash2, CheckCircle2, AlertCircle, BookOpen } from 'lucide-react';

interface ApiToken {
  id: string;
  name: string;
  token: string;
  project_ids: number[];
  permissions: string[];
  status: string;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
  level: number;
  children: Project[];
}

const ApiConfig: React.FC = () => {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [formData, setFormData] = useState({ name: '', project_ids: [] as number[], permissions: ['read_data'] as string[] });
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    fetchTokens();
    fetchProjects();
  }, []);

  const fetchTokens = () => {
    fetch('/api/tokens')
      .then(res => res.json())
      .then(res => { if (res.success) setTokens(res.data); })
      .catch(console.error);
  };

  const fetchProjects = () => {
    fetch('/api/projects')
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
  // 只获取一级项目用于表单选择
  const rootProjects = flatProjects.filter(p => p.level === 1);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return alert('请输入接口名称');
    
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const result = await res.json();
      if (result.success) {
        setIsModalOpen(false);
        setFormData({ name: '', project_ids: [], permissions: ['read_data'] });
        fetchTokens();
      } else {
        alert(result.error);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除该接口令牌吗？删除后正在使用该令牌的应用将无法获取数据。')) return;
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
      const result = await res.json();
      if (result.success) fetchTokens();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopy = async (token: string, id: string) => {
    let success = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(token);
        success = true;
      }
    } catch (e) {
      // fall through to legacy path
    }
    if (!success) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = token;
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        textarea.setAttribute('readonly', '');
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        success = true;
      } catch {}
    }
    if (success) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } else {
      alert('复制失败，请手动选择并复制 Token');
    }
  };

  const handleProjectToggle = (projectId: number) => {
    setFormData(prev => ({
      ...prev,
      project_ids: prev.project_ids.includes(projectId)
        ? prev.project_ids.filter(id => id !== projectId)
        : [...prev.project_ids, projectId]
    }));
  };

  const handlePermissionToggle = (perm: string) => {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(perm)
        ? prev.permissions.filter(p => p !== perm)
        : [...prev.permissions, perm]
    }));
  };

  const getPermissionNames = (perms: string[]) => {
    if (!perms || perms.length === 0) return '无权限';
    const map: Record<string, string> = {
      'read_data': '接收数据',
      'send_command': '下发指令'
    };
    return perms.map(p => map[p] || p).join(', ');
  };

  const getProjectNames = (ids: number[]) => {
    if (!ids || ids.length === 0) return '所有项目 (全局权限)';
    return ids.map(id => flatProjects.find(p => p.id === id)?.name || id).join('、');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-start gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-800">接口管理 (数据共享 API)</h2>
          <p className="text-sm text-gray-500 mt-1">生成访问令牌，配置项目权限，以便第三方系统通过 API 读取实时遥测数据</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 w-full lg:w-auto">
          <button 
            onClick={() => setIsGuideOpen(true)}
            className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg flex items-center justify-center space-x-2 transition-colors shadow-sm w-full sm:w-auto"
          >
            <BookOpen className="w-4 h-4" />
            <span>使用说明</span>
          </button>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center justify-center space-x-2 transition-colors shadow-sm w-full sm:w-auto"
          >
            <Plus className="w-4 h-4" />
            <span>新建令牌</span>
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">接口名称</th>
                <th className="hidden sm:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">访问令牌 (Token)</th>
                <th className="hidden md:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">权限内容</th>
                <th className="hidden lg:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">项目范围</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
                <th className="hidden xl:table-cell px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">创建时间</th>
                <th className="px-4 lg:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 lg:px-6 py-8 text-center text-gray-500">
                    <Key className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p>暂无 API 令牌，请点击右上角新建</p>
                  </td>
                </tr>
              ) : (
                tokens.map((token) => (
                  <tr key={token.id} className="hover:bg-gray-50">
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{token.name}</td>
                    <td className="hidden sm:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                      <div className="flex items-center space-x-2">
                        <span>{token.token.substring(0, 8)}...{token.token.substring(token.token.length - 8)}</span>
                        <button 
                          onClick={() => handleCopy(token.token, token.id)}
                          className="text-gray-400 hover:text-blue-600 transition-colors p-1"
                          title="复制完整 Token"
                        >
                          {copiedId === token.id ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                    <td className="hidden md:table-cell px-4 lg:px-6 py-4 text-sm text-gray-500">
                      <div className="flex flex-wrap gap-1">
                        {token.permissions?.map(p => (
                          <span key={p} className={`px-2 py-1 text-xs font-medium rounded-full ${p === 'read_data' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>
                            {p === 'read_data' ? '接收数据' : '下发指令'}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="hidden lg:table-cell px-4 lg:px-6 py-4 text-sm text-gray-500 max-w-xs truncate" title={getProjectNames(token.project_ids)}>
                      {getProjectNames(token.project_ids)}
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap">
                      <span className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                        {token.status}
                      </span>
                    </td>
                    <td className="hidden xl:table-cell px-4 lg:px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(token.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 lg:px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <button
                        onClick={() => handleDelete(token.id)}
                        className="text-red-600 hover:text-red-900 transition-colors p-1"
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

      {/* Guide Modal */}
      {isGuideOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <div className="flex items-center space-x-3">
                <BookOpen className="w-6 h-6 text-blue-600 flex-shrink-0" />
                <h3 className="text-xl font-semibold text-gray-800">第三方系统接口调用指南</h3>
              </div>
              <button 
                onClick={() => setIsGuideOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100 transition-colors"
              >
                <span className="text-2xl leading-none">&times;</span>
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              <div className="text-sm text-gray-700 space-y-6 leading-relaxed">
                <p className="text-base text-gray-600">
                  本系统提供标准的 RESTful API 供第三方系统直接调用和集成。当您创建一个访问令牌（Token）后，即可通过该令牌获取授权范围内的网关遥测数据或下发控制指令。
                </p>

                <div>
                  <h4 className="text-base font-bold text-gray-900 mb-3 flex items-center"><span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm mr-2">1</span>获取遥测数据接口</h4>
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 space-y-2">
                    <p><strong>请求路径:</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded text-pink-600 font-mono">GET /api/shared/telemetry</code></p>
                    <p><strong>鉴权方式:</strong> HTTP Header 添加 <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">Authorization: Bearer &lt;Token&gt;</code></p>
                    <p><strong>查询参数(可选):</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">start</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">end</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">limit</code></p>
                    <p className="text-gray-600">不传参数时，按北京时间自然日返回授权项目当天每个点位最新的一条数据，不受固定条数限制；传入时间或 limit 参数时，按原有方式查询时间范围内的遥测记录。</p>
                    <p className="text-amber-700">时区说明：start、end 请携带明确时区，按北京时间查询时建议使用 +08:00，例如 2026-11-01T00:00:00+08:00。响应中的 ts 为 UTC 时间（末尾带 Z），展示北京时间时请转换为 Asia/Shanghai；例如 2026-11-01T09:15:00.000Z 对应北京时间 2026-11-01 17:15:00。</p>
                  </div>
                </div>

                <div>
                  <h4 className="text-base font-bold text-gray-900 mb-3 flex items-center"><span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm mr-2">2</span>下发控制指令接口</h4>
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 space-y-2">
                    <p><strong>请求路径:</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded text-pink-600 font-mono">POST /api/shared/control</code></p>
                    <p><strong>鉴权方式:</strong> HTTP Header 添加 <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">Authorization: Bearer &lt;Token&gt;</code></p>
                    <p><strong>请求体 (JSON):</strong> <br/>
                      <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono block mt-1">
                        &#123; "sncode": "网关SN码", "command": &#123; "datas": [ ... ] &#125; &#125;
                      </code>
                    </p>
                  </div>
                </div>

                <div>
                  <h4 className="text-base font-bold text-gray-900 mb-3 flex items-center"><span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-sm mr-2">3</span>获取环境监测数据接口</h4>
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 space-y-2">
                    <p><strong>请求路径:</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded text-pink-600 font-mono">GET /api/shared/environment-monitor</code></p>
                    <p><strong>鉴权方式:</strong> 与遥测接口相同，HTTP Header 添加 <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">Authorization: Bearer &lt;Token&gt;</code>，令牌需有“接收数据”权限。</p>
                    <p><strong>查询参数(可选):</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">start</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">end</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">limit</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">projectCode</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">deviceAddr</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">functionCode</code></p>
                    <p className="text-gray-600">不传时间和 limit 时，返回授权项目当日每个设备节点/监测因子的最新一条数据；传入时间范围或 limit 时，返回按监测时间倒序排列的记录，默认最多 5000 条，limit 最大 20000 条。父项目令牌包含其子项目。</p>
                    <p><strong>响应字段示例:</strong> <code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">project_code</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">device_addr</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">function_code</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">function_name</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">value</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">unit</code>、<code className="bg-white border border-gray-200 px-2 py-1 rounded font-mono">sample_time</code></p>
                    <pre className="bg-gray-900 text-gray-100 p-3 rounded-lg font-mono text-xs overflow-x-auto">{`curl 'https://caiji.boningse.com/api/shared/environment-monitor?functionCode=6000019' \\\n  -H 'Authorization: Bearer YOUR_TOKEN'`}</pre>
                  </div>
                </div>

                <div>
                  <h4 className="text-base font-bold text-gray-900 mb-3 flex items-center"><span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm mr-2">4</span>返回码说明</h4>
                  <div className="bg-gray-50 rounded-lg p-4 border border-gray-100 text-sm text-gray-700">
                    <p className="mb-1"><span className="font-mono px-2 py-0.5 bg-green-100 text-green-700 rounded">code: 0</span> 成功</p>
                    <p className="mb-1"><span className="font-mono px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded">code: 400</span> 参数错误（如时间格式无效、start &gt; end 等）</p>
                    <p className="mb-1"><span className="font-mono px-2 py-0.5 bg-red-100 text-red-700 rounded">code: 401</span> 未授权或令牌失效</p>
                    <p className="mb-1"><span className="font-mono px-2 py-0.5 bg-red-100 text-red-700 rounded">code: 403</span> 权限不足（令牌不包含该项目）</p>
                    <p className="mb-1"><span className="font-mono px-2 py-0.5 bg-red-100 text-red-700 rounded">code: 500</span> 服务器内部错误</p>
                  </div>
                </div>

                <div>
                  <h4 className="text-base font-bold text-gray-900 mb-3 flex items-center"><span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm mr-2">5</span>响应数据结构示例</h4>
                  <div className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm overflow-x-auto whitespace-pre">
{`{
  "success": true,
  "code": 0,
  "data": [
    {
      "id": "10023",
      "gateway_sncode": "1211692AF4224BF6",
      "device_code": "",
      "point_name": "",
      "insname": "3702152601",
      "propertyno": "231",
      "paraname": "",
      "quality": 0,
      "value": "24.5",
      "ts": "2024-08-15T08:30:00.000Z",
      "project_code": "PRJ-001",
      "project_name": "山东伯宁项目"
    }
  ]
}`}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end rounded-b-xl">
              <button 
                onClick={() => setIsGuideOpen(false)}
                className="px-6 py-2.5 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 rounded-lg font-medium shadow-sm transition-colors"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-semibold text-gray-800">新建 API 令牌</h3>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-100 transition-colors"
              >
                <AlertCircle className="w-6 h-6 opacity-0 hidden" /> {/* spacer */}
                <span className="text-2xl leading-none">&times;</span>
              </button>
            </div>
            
            <form onSubmit={handleCreate} className="flex flex-col flex-1 overflow-hidden">
              <div className="p-6 space-y-6 flex-1 overflow-y-auto">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    接口用途名称 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder="例如: 大屏展示系统接入"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-base"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    授权操作权限 <span className="text-red-500">*</span>
                  </label>
                  <div className="flex space-x-6">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={formData.permissions.includes('read_data')}
                        onChange={() => handlePermissionToggle('read_data')}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">接收数据 (Telemetry)</span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={formData.permissions.includes('send_command')}
                        onChange={() => handlePermissionToggle('send_command')}
                        className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">下发指令 (Command)</span>
                    </label>
                  </div>
                </div>

                <div className="flex-1 flex flex-col">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    授权访问的一级项目 (可多选，不选则为全局权限，选择后自动包含其下所有子项目)
                  </label>
                  <div className="flex-1 border border-gray-200 rounded-lg p-4 bg-gray-50 overflow-y-auto min-h-[300px]">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {rootProjects.map(project => (
                        <label key={project.id} className="flex items-center space-x-3 p-2.5 bg-white border border-gray-100 hover:border-blue-300 hover:shadow-sm rounded-lg cursor-pointer transition-all">
                          <input 
                            type="checkbox"
                            checked={formData.project_ids.includes(project.id)}
                            onChange={() => handleProjectToggle(project.id)}
                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700 font-medium truncate" title={project.name}>
                            {project.name}
                          </span>
                        </label>
                      ))}
                      {rootProjects.length === 0 && (
                        <div className="col-span-full text-center text-gray-400 py-8">
                          暂无可选的一级项目，请先在“项目管理”中添加
                        </div>
                      )}
                    </div>
                  </div>
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
                  生成令牌
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApiConfig;
