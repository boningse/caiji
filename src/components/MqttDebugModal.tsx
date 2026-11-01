import React, { useState, useEffect, useRef } from 'react';
import { X, Send, Activity, Trash2, Power } from 'lucide-react';

interface Gateway {
  sncode: string;
  alias: string;
  publish_topic?: string;
  subscribe_topic?: string;
  status: string;
}

interface MqttDebugModalProps {
  gateway: Gateway;
  onClose: () => void;
}

interface LogMessage {
  id: number;
  time: string;
  type: 'info' | 'error' | 'receive' | 'send';
  content: string;
}

const MqttDebugModal: React.FC<MqttDebugModalProps> = ({ gateway, onClose }) => {
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [command, setCommand] = useState('{\n  "datas": [\n    {\n      "insno": "",\n      "propertyno": "",\n      "value": ""\n    }\n  ]\n}');
  const [isConnected, setIsConnected] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const token = localStorage.getItem('token');

  const addLog = (type: LogMessage['type'], content: any) => {
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);
    setLogs(prev => {
      // Prevent exact duplicate logs within a short timeframe (e.g. 2 seconds)
      const isDuplicate = prev.some(log => 
        log.content === textContent && 
        log.type === type &&
        Date.now() - Number(log.id) < 2000
      );
      if (isDuplicate) return prev;

      return [...prev, {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString(),
        type,
        content: textContent
      }].slice(-100);
    }); // Keep last 100 logs
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    addLog('info', `Connecting to WebSocket server...`);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setIsConnected(true);
      addLog('info', 'WebSocket connected. Waiting for authentication...');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', token }));
        } else if (data.type === 'auth_success') {
          addLog('info', 'Authentication successful. Waiting for gateway data...');
        } else if (data.type === 'mqtt_message') {
          // Filter logs for this specific gateway
          const payloadStr = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
          
          let isMatch = false;
          // Condition 1: Exact topic match (if subscribe_topic is configured)
          if (gateway.subscribe_topic && data.topic === gateway.subscribe_topic) {
            isMatch = true;
          } 
          // Condition 2: Payload contains the SN code
          else if (payloadStr.includes(gateway.sncode)) {
            isMatch = true;
          }
          // Condition 3: Match ACK topic related to the gateway's publish_topic
          // E.g., if publish_topic is "device/control", ACK might be "device/control/ack" or "device/ack"
          // Here we check if the incoming topic contains "ack" AND is somehow related to this gateway
          else if (gateway.publish_topic && data.topic.includes('ack') && 
                  (data.topic.includes(gateway.publish_topic) || gateway.publish_topic.includes(data.topic.replace('/ack', '')))) {
            isMatch = true;
          }
          // Fallback Condition: It is a command response ("results" array) and contains "success"
          else if (payloadStr.includes('"results"') && payloadStr.includes('"success"')) {
            isMatch = true;
          }
                          
          if (isMatch) {
            addLog('receive', `[上报 | ${data.topic}] ${payloadStr}`);
          }
        }
      } catch (e) {
        // Ignore non-json
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      addLog('error', 'WebSocket disconnected.');
    };

    ws.onerror = () => {
      addLog('error', 'WebSocket error.');
    };

    wsRef.current = ws;
  };

  const handleSendCommand = async () => {
    if (!command.trim()) return;
    if (!gateway.publish_topic) {
      addLog('error', '网关未配置发布主题，无法下发命令');
      return;
    }

    setIsSending(true);
    addLog('send', `[下发] ${command}`);

    try {
      // Parse command to ensure it's valid JSON if possible
      let parsedCommand;
      try {
        parsedCommand = JSON.parse(command);
      } catch (e) {
        parsedCommand = command; // Send as string if not JSON
      }

      const response = await fetch('/api/gateways/control', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          sncode: gateway.sncode,
          command: parsedCommand
        })
      });

      const result = await response.json();
      if (result.success) {
        addLog('info', '命令发送成功，等待网关响应...');
      } else {
        addLog('error', `发送失败: ${result.error}`);
      }
    } catch (error) {
      addLog('error', '发送请求出错');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl flex flex-col h-[80vh]">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <div className="bg-green-100 p-2 rounded-lg text-green-600">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">MQTT 通信调试</h3>
              <div className="text-sm text-gray-500 flex items-center space-x-2 mt-1">
                <span>{gateway.alias}</span>
                <span>({gateway.sncode})</span>
                <span className={`px-2 py-0.5 rounded text-xs ${
                  gateway.status === 'ONLINE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {gateway.status}
                </span>
                <span className={`flex items-center space-x-1 text-xs ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
                  <Power className="w-3 h-3" />
                  <span>{isConnected ? 'WS已连接' : 'WS未连接'}</span>
                </span>
              </div>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-h-0 bg-gray-50 p-6 space-y-4">
          
          {/* Logs Area */}
          <div className="flex-1 bg-gray-900 rounded-lg shadow-inner flex flex-col overflow-hidden border border-gray-800">
            <div className="flex justify-between items-center px-4 py-2 bg-gray-800 border-b border-gray-700">
              <span className="text-xs font-medium text-gray-300">实时通信日志 (自动过滤当前SN)</span>
              <button 
                onClick={() => setLogs([])}
                className="text-gray-400 hover:text-white transition-colors"
                title="清空日志"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 p-4 overflow-y-auto font-mono text-sm space-y-2">
              {logs.length === 0 && (
                <div className="text-gray-600 text-center mt-4">等待数据收发...</div>
              )}
              {logs.map(log => (
                <div key={log.id} className="break-words leading-relaxed">
                  <span className="text-gray-500">[{log.time}] </span>
                  {log.type === 'info' && <span className="text-blue-400">{log.content}</span>}
                  {log.type === 'error' && <span className="text-red-400">{log.content}</span>}
                  {log.type === 'send' && <span className="text-yellow-400 font-semibold">{log.content}</span>}
                  {log.type === 'receive' && <span className="text-green-400">{log.content}</span>}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* Control Area */}
          <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 flex-shrink-0">
            <div className="mb-2 flex justify-between items-end">
              <label className="block text-sm font-medium text-gray-700">
                下发控制指令 (JSON格式)
              </label>
              <div className="text-xs text-gray-500 font-mono flex flex-col items-end">
                <div>发布主题: {gateway.publish_topic || <span className="text-red-500">未配置</span>}</div>
                <div>订阅主题: {gateway.subscribe_topic || <span className="text-gray-400">未配置(使用SN过滤)</span>}</div>
              </div>
            </div>
            <div className="flex space-x-3">
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder='输入 JSON 格式下发指令'
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono text-sm resize-none h-32"
                disabled={!gateway.publish_topic}
              />
              <button
                onClick={handleSendCommand}
                disabled={!gateway.publish_topic || isSending}
                className={`px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg flex flex-col items-center justify-center transition-colors ${
                  (!gateway.publish_topic || isSending) ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <Send className="w-5 h-5 mb-1" />
                <span className="text-sm">{isSending ? '发送中' : '发送指令'}</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default MqttDebugModal;