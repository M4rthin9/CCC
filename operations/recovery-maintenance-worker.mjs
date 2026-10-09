export default {
  fetch(request) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
      'Retry-After': '180',
      'X-Reservation-Recovery': 'maintenance',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    return new Response(JSON.stringify({ status: 'error', message: 'ระบบอยู่ระหว่างกู้คืนข้อมูล กรุณาลองใหม่อีกครั้งในอีกสักครู่' }), { status: 503, headers });
  },
  async scheduled() {},
  async queue(batch) { batch.retryAll({ delaySeconds: 180 }); },
};
