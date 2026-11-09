import { timingSafeEqual } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { Bot, webhookCallback } from 'grammy';
import type { Config } from './config.js';
import type { LocationService } from './services/location-service.js';
import { registerCommands } from './bot/commands.js';
import { createLogger, safeError } from './logging.js';
import type { Logger } from 'pino';

export function createApp(config: Config, service: LocationService, bot = new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } }), logger: boolean | Logger = false) {
  const loggerInstance = typeof logger === 'object' ? logger : logger ? createLogger(config.LOG_LEVEL) : undefined;
  const app = Fastify({
    ...(loggerInstance ? { loggerInstance } : { logger: false }),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
  });
  registerCommands(bot, service, config.TELEGRAM_GROUP_ID, app.log);
  app.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url === '/telegram/webhook') {
      request.log.debug({ event: 'webhook_request_completed', status_code: reply.statusCode, duration_ms: Math.round(reply.elapsedTime) });
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/telegram/webhook', {
    onRequest: async (request, reply) => {
      const supplied = request.headers['x-telegram-bot-api-secret-token'];
      const expected = Buffer.from(config.TELEGRAM_WEBHOOK_SECRET);
      const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        request.log.warn({ event: 'webhook_rejected', reason: 'invalid_secret' });
        return reply.code(403).send({ error: 'Forbidden' });
      }
    },
    schema: { body: { type: 'object', required: ['update_id'], properties: { update_id: { type: 'integer' } } } },
  }, webhookCallback(bot, 'fastify', { onTimeout: 'throw', timeoutMilliseconds: 25_000 }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ event: 'http_request_rejected', status_code: error.statusCode });
      void reply.code(error.statusCode).send({ error: 'Invalid Request' });
      return;
    }
    request.log.error({ event: 'request_failed', ...safeError(error) }, 'Ошибка обработки HTTP запроса');
    void reply.code(500).send({ error: 'Internal Server Error' });
  });
  return app;
}
