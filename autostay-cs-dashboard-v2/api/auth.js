// 대시보드 접근 토큰 인증 게이트
// GET /api/auth: 로그인 화면
// POST /api/auth: 인증 쿠키 발급

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const validToken = process.env.DASHBOARD_TOKEN;
  if (!validToken) {
    return res.status(503).send(errorPage('서버 인증 환경변수가 설정되지 않았습니다.'));
  }

  if (req.method === 'POST') {
    const body = await readBody(req, 4096);
    if (body == null) return res.status(413).send(errorPage('요청 크기가 허용 범위를 초과했습니다.'));
    const token = new URLSearchParams(body).get('token') || '';
    if (token === validToken) return setCookieAndRedirect(req, res, validToken);
    return res.status(401).send(loginPage(true));
  }

  if (req.method === 'GET') {
    const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
    const cookie = parseCookie(req.headers.cookie || '');
    if (cookie[cookieKey] === validToken) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return res.status(200).send(loginPage(false));
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).send('Method Not Allowed');
};

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let body = '';
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      body += chunk.toString();
      if (Buffer.byteLength(body, 'utf8') > maxBytes) exceeded = true;
    });
    req.on('end', () => resolve(exceeded ? null : body));
    req.on('error', () => resolve(null));
  });
}

function setCookieAndRedirect(req, res, token) {
  const maxAge = 60 * 60 * 24 * 7;
  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const host = req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || '';
  const isLocal = /^localhost(?::|$)|^127\.0\.0\.1(?::|$)/.test(host);
  const secure = !isLocal || proto === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${cookieKey}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure}; Max-Age=${maxAge}; SameSite=Lax`,
  );
  res.writeHead(302, { Location: '/' });
  res.end();
}

function parseCookie(str) {
  const out = {};
  str.split(';').forEach((part) => {
    const [key, ...value] = part.trim().split('=');
    if (!key) return;
    try {
      out[key.trim()] = decodeURIComponent(value.join('='));
    } catch (_) {
      out[key.trim()] = value.join('=');
    }
  });
  return out;
}

function loginPage(failed) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>[OPS] 채널톡 CS 대시보드 · 인증</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;min-height:100%}
    body{min-height:100vh;display:grid;place-items:center;padding:24px;background:#f2f4f6;color:#191f28;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .shell{width:min(100%,420px)}
    .brand{margin-bottom:24px}
    .eyebrow{margin:0 0 8px;color:#3182f6;font-size:12px;font-weight:800;letter-spacing:0}
    h1{margin:0;font-size:27px;line-height:1.25;letter-spacing:0}
    .sub{margin:9px 0 0;color:#6b7684;font-size:14px;line-height:1.55}
    .card{padding:28px;background:#fff;border:1px solid #e5e8eb;border-radius:8px;box-shadow:0 12px 36px rgba(25,31,40,.08)}
    label{display:block;margin-bottom:9px;color:#4e5968;font-size:13px;font-weight:700}
    input{width:100%;height:48px;padding:0 14px;border:1px solid ${failed ? '#f04452' : '#d1d6db'};border-radius:8px;background:#fff;color:#191f28;font-size:15px;outline:none}
    input:focus{border-color:#3182f6;box-shadow:0 0 0 3px rgba(49,130,246,.12)}
    .error{display:${failed ? 'block' : 'none'};margin:8px 0 0;color:#d22030;font-size:12px}
    button{width:100%;height:48px;margin-top:18px;border:0;border-radius:8px;background:#3182f6;color:#fff;font-size:15px;font-weight:800;cursor:pointer}
    button:hover{background:#1b64da}
    .hint{margin:16px 0 0;color:#8b95a1;font-size:12px;line-height:1.55;text-align:center}
  </style>
</head>
<body>
  <main class="shell">
    <header class="brand">
      <p class="eyebrow">AUTOSTAY OPS</p>
      <h1>[OPS] 채널톡 CS 대시보드</h1>
      <p class="sub">내부 운영 데이터 보호를 위해 접근 토큰을 확인합니다.</p>
    </header>
    <section class="card" aria-label="대시보드 인증">
      <form method="POST" action="/api/auth">
        <label for="token">접근 토큰</label>
        <input type="password" id="token" name="token" placeholder="공유받은 토큰을 입력하세요" autofocus autocomplete="current-password" required>
        <p class="error" role="alert">토큰이 올바르지 않습니다. 다시 확인해 주세요.</p>
        <button type="submit">대시보드 열기</button>
      </form>
      <p class="hint">OPS 내부 사용자 전용 화면입니다.<br>접근 권한은 운영 관리자에게 문의하세요.</p>
    </section>
  </main>
</body>
</html>`;
}

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>[OPS] 채널톡 CS 대시보드 · 설정 오류</title>
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f2f4f6;color:#d22030;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}p{margin:8px 0;color:#4e5968}</style>
</head>
<body><main><h1>대시보드를 열 수 없습니다</h1><p>${message}</p></main></body>
</html>`;
}
