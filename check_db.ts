import { query } from './api/db.js';

async function main() {
  try {
    const res = await query('SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(*) as cnt FROM telemetry_data_2026_03');
    console.log('telemetry_data_2026_03 summary:', res.rows[0]);
    
    const res2 = await query('SELECT ts FROM telemetry_data_2026_03 ORDER BY ts ASC LIMIT 5');
    console.log('Earliest 5 rows:', res2.rows);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
main();