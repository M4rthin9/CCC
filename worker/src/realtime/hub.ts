import type { Env, RealTimeEvent } from '../types';
import { REALTIME_MAX_CONN_PER_IP } from '../lib/constants';

const ROOMS = ['public', 'admin'] as const;
type Room = (typeof ROOMS)[number];

interface ClientMeta {
  room: Room;
  ip: string;
}

export class RealtimeHub implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private clients = new Map<WebSocket, ClientMeta>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/publish') || url.pathname.endsWith('/publish/')) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const event = (await request.json().catch(() => null)) as RealTimeEvent | null;
      if (event) this.broadcast(event);
      return new Response('ok');
    }

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const roomParam = url.searchParams.get('room') || 'public';
    const room: Room = roomParam === 'admin' ? 'admin' : 'public';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const connCount = Array.from(this.clients.values()).filter((c) => c.ip === ip).length;
    if (connCount >= REALTIME_MAX_CONN_PER_IP) {
      return new Response('too many connections', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.clients.set(server, { room, ip });
    this.state.acceptWebSocket(server);
    try {
      server.send(JSON.stringify({ type: 'connected', room }));
    } catch {
      // ignore
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    try {
      const parsed = JSON.parse(message);
      if (parsed && parsed.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // ignore non-JSON frames
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.clients.delete(ws);
  }

  private broadcast(event: RealTimeEvent): void {
    const msg = JSON.stringify(event);
    for (const [ws] of this.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      } catch {
        // ignore disconnected clients
      }
    }
  }
}

export async function publishRealtime(env: Env, event: RealTimeEvent): Promise<void> {
  try {
    const id = env.REALTIME_HUB.idFromName('hub');
    const stub = env.REALTIME_HUB.get(id);
    await stub.fetch('https://realtime/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // realtime is best-effort; clients fall back to polling
  }
}
