// middleware.js — Vercel Edge Middleware
// 정적 리소스(HTML, CSS, JS) + API 모두에 인증 게이트 적용
// 환경변수: DASHBOARD_TOKEN, COOKIE_KEY (선택, 기본 'ds_auth')

export const config = {
  // /api/auth, /api/check, favicon, robots는 우회 (인증 없이 접근)
  matcher: [
    '/((?!api/auth|api/check|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)',
  ],
};

export default function middleware(request) {
  const validToken = process.env.DASHBOARD_TOKEN;

  // 토큰 미설정 시 인증 비활성화 (로컬 개발용)
  if (!validToken) return;

  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const cookies = request.headers.get('cookie') || '';
  const re = new RegExp(`(?:^|;\\s*)${cookieKey}=([^;]+)`);
  const m = cookies.match(re);
  const token = m ? decodeURIComponent(m[1]) : null;

  // 인증 통과
  if (token === validToken) return;

  // 인증 실패 처리
  const url = new URL(request.url);
  const path = url.pathname;

  // 정적 리소스(.css/.js/.png/.svg 등)는 401 응답
  const isAsset = /\.(css|js|mjs|png|jpg|jpeg|svg|ico|woff2?|ttf|webp|gif|map)$/i.test(path);
  if (isAsset) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // /api/* 요청은 401 JSON 응답 (대시보드 페이지 fetch 시 처리 위함)
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized', redirect: '/api/auth' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // HTML 페이지 요청 → 인증 페이지로 redirect
  return Response.redirect(new URL('/api/auth', request.url), 302);
}
