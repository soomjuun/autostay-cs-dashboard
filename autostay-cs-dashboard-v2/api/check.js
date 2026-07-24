// 초기 화면에서 무거운 데이터 조회 없이 인증 상태만 확인한다.

function parseCookie(str) {
  const out = {};
  (str || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1);
    try { value = decodeURIComponent(value); } catch (_) {}
    if (key) out[key] = value;
  });
  return out;
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const dashboardToken = process.env.DASHBOARD_TOKEN;
  if (!dashboardToken) {
    return res.status(503).json({ ok: false, error: 'Dashboard authentication is not configured' });
  }

  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const cookie = parseCookie(req.headers.cookie);
  if (cookie[cookieKey] === dashboardToken) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ ok: false, redirect: '/api/auth' });
};
