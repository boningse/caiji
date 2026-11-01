import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Settings, Activity, Database, Users, FolderTree, LogOut, Send, Settings2, Menu, X, Droplets, PanelLeftClose, PanelLeftOpen, MapPin, CloudSun } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true'
  );
  
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  const navigation = [
    { name: '信息总览', href: '/', icon: LayoutDashboard },
    { name: '项目管理', href: '/projects', icon: FolderTree },
    { name: '设备配置', href: '/devices', icon: Settings },
    { name: '点位管理', href: '/points', icon: MapPin },
    { name: '设备属性', href: '/device-types', icon: Settings2 },
    { name: '数据采集', href: '/realtime', icon: Activity },
    { name: '数据接收', href: '/meter-reception', icon: Droplets },
    { name: '环境监测', href: '/environment-monitor/data', icon: CloudSun },
    { name: '数据分发', href: '/data-distribution', icon: Send },
    ...(currentUser.role === 'ADMIN' ? [{ name: '接口管理', href: '/api-config', icon: Database }] : []),
    ...(currentUser.role === 'ADMIN' ? [{ name: '系统管理', href: '/system', icon: Users }] : []),
  ];

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed(previous => {
      const next = !previous;
      localStorage.setItem('sidebarCollapsed', String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-blue-900 text-white flex flex-col transform transition-all duration-300 ease-in-out
        ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-[12.8rem]'}
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className={`h-16 flex items-center border-b border-blue-800 justify-between ${sidebarCollapsed ? 'px-4 lg:px-2' : 'px-4 lg:px-3'}`}>
          <span className="text-xl font-bold lg:hidden">BN网关管理系统</span>
          <span className={`hidden lg:inline font-bold whitespace-nowrap ${sidebarCollapsed ? 'text-sm' : 'text-base'}`}>
            {sidebarCollapsed ? 'BN' : 'BN网关管理系统'}
          </span>
          <button
            onClick={toggleSidebarCollapsed}
            className="hidden lg:flex p-1.5 rounded-md text-blue-200 hover:text-white hover:bg-blue-800 transition-colors"
            title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
            aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </button>
          <button 
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-white hover:text-blue-200"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        <nav className={`flex-1 py-6 space-y-2 overflow-y-auto ${sidebarCollapsed ? 'px-4 lg:px-2' : 'px-4 lg:px-3'}`}>
          {navigation.map((item) => {
            const Icon = item.icon;
            const isEnvironmentMonitorActive = item.href.startsWith('/environment-monitor') && location.pathname.startsWith('/environment-monitor');
            const isActive = location.pathname === item.href || isEnvironmentMonitorActive;
            return (
              <Link
                key={item.name}
                to={item.href}
                onClick={() => setSidebarOpen(false)}
                title={sidebarCollapsed ? item.name : undefined}
                className={`flex items-center py-3 rounded-lg transition-colors ${
                  sidebarCollapsed ? 'px-4 lg:px-2 lg:justify-center space-x-3 lg:space-x-0' : 'space-x-3 px-4 lg:px-3'
                } ${
                  isActive ? 'bg-blue-800 text-white' : 'text-blue-200 hover:bg-blue-800 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className={sidebarCollapsed ? 'lg:hidden' : ''}>{item.name}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white shadow-sm flex items-center px-4 lg:px-8 justify-between">
          <div className="flex items-center space-x-4">
            <button 
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-gray-600 hover:text-gray-800"
            >
              <Menu className="w-6 h-6" />
            </button>
            <h1 className="text-lg lg:text-xl font-semibold text-gray-800 truncate">
              {navigation.find(n => n.href === location.pathname || (n.href.startsWith('/environment-monitor') && location.pathname.startsWith('/environment-monitor')))?.name || '系统'}
            </h1>
          </div>
          <div className="flex items-center space-x-2 lg:space-x-4">
            <span className="text-xs lg:text-sm text-gray-500 hidden sm:block">{currentUser.username} ({currentUser.role === 'ADMIN' ? '管理员' : '用户'})</span>
            <span className="text-xs text-gray-500 sm:hidden">{currentUser.username}</span>
            <button 
              onClick={handleLogout}
              className="text-gray-500 hover:text-red-600 transition-colors"
              title="退出登录"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-4 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;
