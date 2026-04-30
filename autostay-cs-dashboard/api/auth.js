// api/auth.js — 대시보드 접근 토큰 인증 게이트
// 동작: GET /api/auth?token=XXX  → 쿠키 발급 후 / 리다이렉트
//       GET /api/auth             → 비밀번호 입력 폼 반환
//       POST /api/auth (body: token=XXX) → 쿠키 발급 후 / 리다이렉트

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const VALID_TOKEN = process.env.DASHBOARD_TOKEN;

  if (!VALID_TOKEN) {
    // 환경변수 미설정 시 경고
    return res.status(500).send(errorPage('서버 설정 오류: DASHBOARD_TOKEN 환경변수가 설정되지 않았습니다.'));
  }

  // ── POST: form 제출 ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = '';
    await new Promise((resolve) => {
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', resolve);
    });
    const params = new URLSearchParams(body);
    const token = params.get('token') || '';
    if (token === VALID_TOKEN) {
      setCookieAndRedirect(res, VALID_TOKEN);
    } else {
      return res.status(401).send(loginPage(true));
    }
    return;
  }

  // ── GET: 쿼리스트링 토큰 검증 ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const token = (req.query && req.query.token) || '';
    if (token && token === VALID_TOKEN) {
      setCookieAndRedirect(res, VALID_TOKEN);
      return;
    }
    // 이미 쿠키 보유 여부 확인
    const cookie = parseCookie(req.headers.cookie || '');
    if (cookie.ds_auth === VALID_TOKEN) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    // 폼 표시
    return res.status(200).send(loginPage(false));
  }

  return res.status(405).send('Method Not Allowed');
};

// ── 쿠키 발급 + 리다이렉트 ────────────────────────────────────────────────────
function setCookieAndRedirect(res, token) {
  const maxAge = 60 * 60 * 24 * 7; // 7일
  res.setHeader('Set-Cookie', `ds_auth=${token}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax`);
  res.writeHead(302, { Location: '/' });
  res.end();
}

// ── 쿠키 파싱 헬퍼 ───────────────────────────────────────────────────────────
function parseCookie(str) {
  const out = {};
  str.split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  });
  return out;
}

// ── 로그인 폼 HTML ────────────────────────────────────────────────────────────
function loginPage(failed) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[OPS] 채널톡 CS 대시보드 — 인증</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1f2e;
      border: 1px solid #2d3748;
      border-radius: 16px;
      padding: 48px 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-icon {
      font-size: 40px;
      display: block;
      margin-bottom: 12px;
    }
    .logo-title {
      font-size: 20px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.3px;
    }
    .logo-sub {
      font-size: 13px;
      color: #718096;
      margin-top: 4px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #a0aec0;
      margin-bottom: 8px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #111827;
      border: 1.5px solid ${failed ? '#fc8181' : '#2d3748'};
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 15px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus {
      border-color: #667eea;
    }
    .error-msg {
      font-size: 12px;
      color: #fc8181;
      margin-top: 6px;
      display: ${failed ? 'block' : 'none'};
    }
    button {
      display: block;
      width: 100%;
      margin-top: 20px;
      padding: 13px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button:hover { opacity: 0.9; }
    .hint {
      margin-top: 20px;
      font-size: 12px;
      color: #4a5568;
      text-align: center;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="logo-icon">📊</span>
      <div class="logo-title">[OPS] 채널톡 CS 대시보드</div>
      <div class="logo-sub">내부 전용 · 인증이 필요합니다</div>
    </div>
    <form method="POST" action="/api/auth">
      <label for="token">액세스 토큰</label>
      <input
        type="password"
        id="token"
        name="token"
        placeholder="팀에서 공유된 토큰을 입력하세요"
        autofocus
        autocomplete="current-password"
      >
      <div class="error-msg">⚠ 토큰이 올바르지 않습니다. 다시 확인해주세요.</div>
      <button type="submit">입장하기 →</button>
    </form>
    <p class="hint">이 대시보드는 OPS 팀 내부 전용입니다.<br>토큰이 없다면 팀 관리자에게 문의하세요.</p>
  </div>
</body>
</html>`;
}

// ── 오류 페이지 ───────────────────────────────────────────────────────────────
function errorPage(msg) {
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>설정 오류</title>
<style>body{font-family:sans-serif;background:#0f1117;color:#fc8181;display:flex;align-items:center;justify-content:center;min-height:100vh;}</style>
</head>
<body><div style="text-align:center"><div style="font-size:32px;margin-bottom:16px">⚠</div><p>${msg}</p></div></body>
</html>`;
}
