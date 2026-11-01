import { query } from './api/db.js';

async function check() {
  const result = await query(`
    SELECT count(*), topic, MAX(received_at) 
    FROM raw_mqtt_logs 
    GROUP BY topic, payload 
    HAVING count(*) > 1 
    ORDER BY MAX(received_at) DESC 
    LIMIT 5;
  `);
  console.log('Duplicates in raw_mqtt_logs:', result.rows);
  
  const result2 = await query(`
    SELECT count(*), gateway_sncode, point_name, ts 
    FROM telemetry_data 
    GROUP BY gateway_sncode, point_name, ts 
    HAVING count(*) > 1 
    ORDER BY ts DESC 
    LIMIT 5;
  `);
  console.log('Duplicates in telemetry_data:', result2.rows);
  
  process.exit(0);
}
check();