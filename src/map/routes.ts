import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { mapAuth } from './auth.js';
import { mapFailure, readMapDependency } from './dependencies.js';
import type { MapService } from './service.js';
import { mapModes } from './types.js';
import type { MapSession } from './types.js';

const sessionBody = z.strictObject({ initData: z.string().min(1).max(16_000) });
const dataBody = z.strictObject({
  mode: z.enum(mapModes),
  participantIds: z.array(z.string().regex(/^[1-9]\d{0,15}$/)).max(5_000).optional(),
});
const contentPolicy = [
  "default-src 'none'", "script-src 'self' https://telegram.org", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.geoapify.com", "connect-src 'self' https://*.geoapify.com",
  "worker-src 'self' blob:", "base-uri 'none'", "form-action 'none'",
].join('; ');
const assets = {
  '/map': ['index.html', 'text/html; charset=utf-8'],
  '/map/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/map/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/map/maplibre-gl-worker.mjs': ['maplibre-gl-worker.mjs', 'text/javascript; charset=utf-8'],
} as const;

async function asset(file: string): Promise<Buffer> {
  try { return await readFile(new URL(`../../map-ui/${file}`, import.meta.url)); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return readFile(new URL(`../../dist/map-ui/${file}`, import.meta.url));
  }
}

export function registerMapRoutes(app: FastifyInstance, config: Config, service: MapService, mapKey: string, username: string) {
  const auth = mapAuth(config.TELEGRAM_BOT_TOKEN);
  const origin = new URL(config.PUBLIC_BASE_URL).origin;
  const options = { bodyLimit: 128 * 1024 };
  for (const [path, [file, mime]] of Object.entries(assets)) {
    app.get(path, async (_request, reply) => {
      reply.type(mime).header('Cache-Control', 'no-cache').header('X-Content-Type-Options', 'nosniff');
      if (path === '/map') reply.header('Content-Security-Policy', contentPolicy).header('Referrer-Policy', 'strict-origin-when-cross-origin');
      return asset(file);
    });
  }

  app.post('/api/map/session', options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ error: 'forbidden' });
    const body = sessionBody.safeParse(request.body);
    const id = body.success ? auth.verifyLaunch(body.data.initData) : null;
    if (id === null) return reply.code(401).send({ error: 'invalid_launch' });
    try {
      if (!await readMapDependency('viewer_membership', () => service.isMember(id))) return reply.code(403).send({ error: 'not_a_member' });
    } catch (error) {
      request.log.warn({ event: 'map_membership_unavailable', ...mapFailure(error) });
      return reply.code(503).send({ error: 'unavailable' });
    }
    const style = (name: string) => `https://maps.geoapify.com/v1/styles/${name}/style.json?apiKey=${encodeURIComponent(mapKey)}&attribution=mandatory`;
    const session: MapSession = { token: auth.issue(id), viewerId: String(id), styleUrl: style('positron'),
      darkStyleUrl: style('dark-matter'), checkInUrl: `https://t.me/${username}?start=checkin` };
    return session;
  });

  app.post('/api/map/data', options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ error: 'forbidden' });
    const id = auth.verifySession(request.headers.authorization);
    if (id === null) return reply.code(401).send({ error: 'invalid_session' });
    const body = dataBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      if (!await readMapDependency('viewer_membership', () => service.isMember(id))) return reply.code(403).send({ error: 'not_a_member' });
      return await service.data(id, body.data.mode, body.data.participantIds);
    } catch (error) {
      request.log.warn({ event: 'map_data_unavailable', ...mapFailure(error) });
      return reply.code(503).send({ error: 'unavailable' });
    }
  });
}
