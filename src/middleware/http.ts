import { Env } from '../types';

export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    ''
  ).slice(0, 64);
}

export function getUserAgent(request: Request): string {
  return (request.headers.get('User-Agent') || '').slice(0, 500);
}

export function makeCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

  let allowOrigin = '*';
  if (allowed.length > 0 && !allowed.includes('*')) {
    allowOrigin = allowed.includes(origin) ? origin : 'none';
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowOrigin !== 'none' && allowOrigin !== '*') {
    headers['Vary'] = 'Origin';
  }
  return headers;
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
