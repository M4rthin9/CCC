export function json(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function ok(payload: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ status: 'ok', ...payload }, 200, headers);
}

export function error(message: string, status = 200, headers: Record<string, string> = {}): Response {
  return json({ status: 'error', message }, status, headers);
}

export function notFound(message = 'Not Found'): Response {
  return json({ status: 'error', message }, 404);
}

export function unauthorized(): Response {
  return json({ status: 'error', message: 'Unauthorized' }, 401);
}
