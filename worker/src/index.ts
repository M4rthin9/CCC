import type { Env } from './types';
import { createRouter } from './router';
import { cleanupExpiredDiscipline } from './services/prisoners';
import { archiveOldReservations, backupData } from './services/archive';
import { RealtimeHub } from './realtime/hub';

export { RealtimeHub };

const app = createRouter();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    if (cron === '0 0 * * *') {
      await cleanupExpiredDiscipline(env);
    } else if (cron === '15 0 1 */3 *') {
      await archiveOldReservations(env);
    } else if (cron === '0 1 * * *') {
      await backupData(env);
    }
  },
} satisfies ExportedHandler<Env>;
