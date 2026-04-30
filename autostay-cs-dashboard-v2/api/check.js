// CS Dashboard — Fast Auth Check Endpoint (no data load)
// Used for initial auth guard without triggering the heavy /api/data call

function parseCookie(str) {
  const out = {};
  (str || '').split(';').forEach(function(part) {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1));
    if (k) out[k] = v;
  });
  return out;
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
  // 토큰 미설정 시 개발 환경으로 간주 — 인증 통과
  if (!DASHBOARD_TOKEN) return res.status(200).json({ ok: true });

  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const cookie = parseCookie(req.headers.cookie);
  if (cookie[cookieKey] === DASHBOARD_TOKEN) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ ok: false, redirect: '/api/auth' });
};
