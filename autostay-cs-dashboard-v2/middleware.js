// Vercel Edge Middleware
// 정적 리소스와 API를 포함한 대시보드 전체에 인증 게이트를 적용한다.

export const config = {
  matcher: [
    '/((?!api/auth|api/check|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)',
  ],
};

export default function middleware(request) {
  const validToken = process.env.DASHBOARD_TOKEN;
  if (!validToken) {
    return new Response('Dashboard authentication is not configured', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const cookieKey = process.env.COOKIE_KEY || 'ds_auth';
  const cookies = request.headers.get('cookie') || '';
  const escapedCookieKey = cookieKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapedCookieKey}=([^;]+)`));
  let token = match ? match[1] : null;
  try { token = token ? decodeURIComponent(token) : null; } catch (_) {}
  if (token === validToken) return;

  const url = new URL(request.url);
  const path = url.pathname;
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

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized', redirect: '/api/auth' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return Response.redirect(new URL('/api/auth', request.url), 302);
}
