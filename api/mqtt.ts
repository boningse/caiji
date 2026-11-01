import mqtt from 'mqtt';
import { query } from './db.js';
import dotenv from 'dotenv';
import { broadcast } from './ws.js';
import { ingestData } from './ingestor.js';

dotenv.config();

// Default to user provided config, or fallback to environment variables
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://223.80.108.95:15007';
const MQTT_USERNAME = process.env.MQTT_USERNAME || 'boning';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || 'BoNing@123';
const MQTT_TOPIC_SUB = process.env.MQTT_TOPIC_SUB || 's/+'; // Subscribing to telemetry data
const MQTT_TOPIC_PUB = process.env.MQTT_TOPIC_PUB || 'p/+'; // Topic prefix for publishing commands
const MQTT_ACK_TOPIC_SUB = process.env.MQTT_ACK_TOPIC_SUB || 'p/+'; // Subscribing to gateway ACK topics (p/<sn>ack)

let mqttClient: mqtt.MqttClient | null = null;
let isInitializing = false;

const isPAckTopic = (topic: string) => {
  return /^p\/[^/]+ack$/.test(topic);
};

export const initMqtt = () => {
  if (mqttClient && mqttClient.connected) {
    console.log('MQTT client already connected, skipping...');
    return;
  }
  
  if (isInitializing) return;
  isInitializing = true;

  console.log(`Connecting to MQTT broker at ${MQTT_BROKER}...`);
  
  mqttClient = mqtt.connect(MQTT_BROKER, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: `ag-gateway-collector-${Math.random().toString(16).substring(2, 8)}`,
    reconnectPeriod: 5000,
    clean: false, // 禁用 clean session 确保断线期间不丢失 2000 台设备上报的消息 (QoS > 0 时有效)
    keepalive: 60, // 心跳保活时间
  });

  mqttClient.on('connect', async () => {
    isInitializing = false;
    console.log('Successfully connected to MQTT broker.');
    
    // Subscribe to default topics
    mqttClient?.subscribe(MQTT_TOPIC_SUB, (err) => {
      if (err) {
        console.error(`Failed to subscribe to default topic ${MQTT_TOPIC_SUB}:`, err);
      } else {
        console.log(`Subscribed to default MQTT topic: ${MQTT_TOPIC_SUB}`);
      }
    });

    mqttClient?.subscribe(MQTT_ACK_TOPIC_SUB, (err) => {
      if (err) {
        console.error(`Failed to subscribe to ACK topic ${MQTT_ACK_TOPIC_SUB}:`, err);
      } else {
        console.log(`Subscribed to ACK MQTT topic: ${MQTT_ACK_TOPIC_SUB}`);
      }
    });

    // Dynamically subscribe to all configured subscribe_topic and publish_topic (for ACKs) in gateway_info
    try {
      const gateways = await query('SELECT subscribe_topic, publish_topic FROM gateway_info');
      
      // Remove duplicates before subscribing
      const uniqueTopics = new Set<string>();
      // We already subscribe to MQTT_TOPIC_SUB, so don't subscribe again if it matches exactly
      uniqueTopics.add(MQTT_TOPIC_SUB);
      uniqueTopics.add(MQTT_ACK_TOPIC_SUB);
      
      for (const gw of gateways.rows) {
        if (gw.subscribe_topic && gw.subscribe_topic !== MQTT_TOPIC_SUB) {
          if (isPAckTopic(gw.subscribe_topic)) {
            uniqueTopics.add(MQTT_ACK_TOPIC_SUB);
          } else {
            uniqueTopics.add(gw.subscribe_topic);
          }
        }
        // If there's a publish_topic, also subscribe to its wildcard ack topic
        if (gw.publish_topic) {
          if (typeof gw.publish_topic === 'string' && gw.publish_topic.startsWith('p/')) {
            uniqueTopics.add(MQTT_ACK_TOPIC_SUB);
          } else {
            const baseTopic = gw.publish_topic.split('/').slice(0, -1).join('/');
            if (baseTopic) {
              uniqueTopics.add(`${baseTopic}/#`);
            } else {
              uniqueTopics.add(`${gw.publish_topic}/ack`);
            }
          }
        }
      }

      for (const topic of uniqueTopics) {
        if (topic === MQTT_TOPIC_SUB || topic === MQTT_ACK_TOPIC_SUB) continue; // Already subscribed above
        mqttClient?.subscribe(topic, (err) => {
          if (err) {
            console.error(`Failed to subscribe to custom topic ${topic}:`, err);
          } else {
            console.log(`Subscribed to custom MQTT topic: ${topic}`);
          }
        });
      }
    } catch (e) {
      console.error('Failed to fetch custom subscribe topics from database:', e);
    }
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const payloadString = message.toString();
      // 在生产环境中减少不必要的日志打印，防止撑爆磁盘
      if (process.env.NODE_ENV !== 'production') {
        console.log(`\n[MQTT] Received message on topic: ${topic}`);
        // console.log(`[MQTT] Payload: ${payloadString}`); // 可能会非常大
      }

      // Try to parse as JSON
      const payload = JSON.parse(payloadString);

      // Broadcast to WebSocket clients so the debug page can see ALL incoming messages
      broadcast({ type: 'mqtt_message', topic, payload });

      // Save raw MQTT log first (for debugging and real-time viewing)
      // Try to extract sncode if it exists, otherwise leave it null
      const sncodeForLog = payload?.sncode || null;
      try {
        await query(
          'INSERT INTO raw_mqtt_logs (gateway_sncode, topic, payload) VALUES ($1, $2, $3)',
          [sncodeForLog, topic, payload]
        );
      } catch (logErr) {
        console.error('[MQTT] Failed to save raw log:', logErr);
      }

      // Check if it matches V3/V4 payload format
      if (payload && payload.sncode && payload.dev) {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[MQTT] Valid V3/V4 payload detected for ${payload.sncode}, ingesting...`);
        }
        await ingestData(payload.sncode, payload.dev, payload.time);
      } else if (payload && payload.sncode) {
        // Update online status for any message containing sncode (e.g., heartbeats, responses)
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[MQTT] Updating online status for ${payload.sncode} (non-data message)`);
        }
        await query(
          "UPDATE gateway_info SET status = 'ONLINE', last_online_time = CURRENT_TIMESTAMP WHERE sncode = $1 AND (status != 'ONLINE' OR last_online_time IS NULL OR last_online_time < CURRENT_TIMESTAMP - interval '1 minute')",
          [payload.sncode]
        );
        
        if (payload && Array.isArray(payload.results)) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[MQTT] Gateway command response detected on topic: ${topic}`);
          }
        }
      } else {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[MQTT] Message on ${topic} is valid JSON but not a recognized V3/V4 format.`);
        }
      }
    } catch (e) {
      // It might not be valid JSON, but we still want to broadcast string responses for debugging
      const payloadString = message.toString();
      broadcast({ type: 'mqtt_message', topic, payload: payloadString });
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[MQTT] Message on ${topic} is not valid JSON, broadcasting as string.`);
      }
    }
  });

  mqttClient.on('error', (err) => {
    isInitializing = false;
    console.error('MQTT Client Error:', err);
  });

  mqttClient.on('offline', () => {
    isInitializing = false;
    console.warn('MQTT Client went offline. Attempting to reconnect...');
  });

  // 定期检查网关是否掉线（超过 20 分钟没有数据上报则认为掉线）
  setInterval(async () => {
    try {
      // 由数据库计算超时阈值，避免 Node.js 本地时区与 PostgreSQL 时区不一致时误判离线
      const result = await query(
        "UPDATE gateway_info SET status = 'OFFLINE', last_offline_time = CURRENT_TIMESTAMP WHERE status = 'ONLINE' AND (last_online_time IS NULL OR last_online_time < CURRENT_TIMESTAMP - interval '20 minute') RETURNING sncode"
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[Status Monitor] Marked ${result.rowCount} gateways as OFFLINE due to timeout:`, result.rows.map(r => r.sncode));
      }
    } catch (err) {
      console.error('[Status Monitor] Error checking gateway offline status:', err);
    }
  }, 60 * 1000); // Check every minute
};

export const getMqttClient = () => mqttClient;
