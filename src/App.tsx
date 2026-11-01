import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import DeviceConfig from "./pages/DeviceConfig";
import RealtimeData from "./pages/RealtimeData";
import ProjectManagement from "./pages/ProjectManagement";
import ApiConfig from "./pages/ApiConfig";
import SystemManagement from "./pages/SystemManagement";
import WebSocketConfig from "./pages/WebSocketConfig";
import DataDistribution from "./pages/DataDistribution";
import DeviceTypeConfig from "./pages/DeviceTypeConfig";
import PointManager from "./pages/PointManager";
import Login from "./pages/Login";
import DataReception from "./pages/DataReception";
import EnvironmentMonitor from "./pages/EnvironmentMonitor";

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('token');
  return token ? <>{children}</> : <Navigate to="/login" />;
};

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        
        {/* Protected Routes */}
        <Route
          path="*"
          element={
            <PrivateRoute>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/devices" element={<DeviceConfig />} />
                  <Route path="/projects" element={<ProjectManagement />} />
                  <Route path="/realtime" element={<RealtimeData />} />
                  <Route path="/meter-reception" element={<DataReception />} />
                  <Route path="/environment-monitor" element={<Navigate to="/environment-monitor/data" replace />} />
                  <Route path="/environment-monitor/config" element={<EnvironmentMonitor view="config" />} />
                  <Route path="/environment-monitor/data" element={<EnvironmentMonitor view="data" />} />
                  <Route path="/api-config" element={<ApiConfig />} />
                  <Route path="/data-distribution" element={<DataDistribution />} />
                  <Route path="/points" element={<PointManager />} />
                  <Route path="/device-types" element={<DeviceTypeConfig />} />
                  <Route path="/ws-config" element={<WebSocketConfig />} />
                  <Route path="/system" element={<SystemManagement />} />
                </Routes>
              </Layout>
            </PrivateRoute>
          }
        />
      </Routes>
    </Router>
  );
}
