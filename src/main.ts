import { Bot } from 'grammy';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createGoogleSheetsRepository } from './adapters/google-sheets-repository.js';
import { LocationService } from './services/location-service.js';
import { GeoapifyGeocoder } from './adapters/geoapify-geocoder.js';
import { PinnedMessageService } from './services/pinned-message-service.js';
import { createLogger, logOperation, safeError } from './logging.js';
import { isGroupMember } from './bot/membership.js';
import { registerWebhook } from './bot/webhook-setup.js';
import { PlaceResolver } from './map/places.js';
import { MapService } from './map/service.js';

const logger = createLogger();
let startupStage = 'configuration';

async function initializeTelegram(setup: () => Promise<void>, signal: AbortSignal): Promise<void> {
  let retryDelay = 5_000;
  while (!signal.aborted) {
    try {
      await setup();
      return;
    } catch (error) {
      if (signal.aborted) return;
      logger.warn({ event: 'telegram_setup_retry', retry_delay_ms: retryDelay, ...safeError(error) });
    }
    await delay(retryDelay, undefined, { ref: false, signal });
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }
}

async function main(): Promise<void> {
  logger.info({ event: 'app_starting' });
  const config = loadConfig();
  startupStage = 'sheets_initialize';
  const repository = createGoogleSheetsRepository(config, logger.child({ component: 'google_sheets' }));
  let migrationRequired = false;
  try { await repository.initialize(); }
  catch (error) {
    if (!(error instanceof Error && error.message === 'sheets_migration_required')) throw error;
    migrationRequired = true;
    logger.warn({ event: 'sheets_migration_required' }, 'Новая версия запущена в ожидании ручной миграции. Данные не изменяются.');
  }
  const geocoder = new GeoapifyGeocoder(config.GEOAPIFY_API_KEY);
  const service = new LocationService(repository, geocoder);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } });
  const map = config.GEOAPIFY_MAPS_API_KEY ? new MapService(repository, id => isGroupMember(bot.api, config.TELEGRAM_GROUP_ID, id),
    new PlaceResolver((...args) => geocoder.searchMapPlace(...args))) : undefined;
  let pinnedService: PinnedMessageService | undefined;
  const pinned = { update: () => {
    pinnedService ??= new PinnedMessageService(repository, service, bot.api, config.TELEGRAM_GROUP_ID, logger, bot.botInfo.username, config.MAP_APP_SHORT_NAME);
    return pinnedService.update();
  } };
  const app = createApp(config, service, bot, logger, pinned, map);
  const telegramSetup = new AbortController();
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    telegramSetup.abort();
    logger.info({ event: 'shutdown_started', signal });
    const timer = setTimeout(() => {
      logger.error({ event: 'shutdown_timed_out' });
      process.exit(1);
    }, 30_000).unref();
    try {
      await app.close();
      logger.info({ event: 'shutdown_completed' });
    } catch (error) {
      logger.error({ event: 'shutdown_failed', ...safeError(error) });
      process.exitCode = 1;
    }
    finally { clearTimeout(timer); }
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  startupStage = 'http_listen';
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ event: 'app_ready', port: config.PORT });
  void initializeTelegram(async () => {
    if (!bot.isInited()) {
      bot.botInfo = await logOperation(logger, 'telegram_initialize', () => bot.api.getMe());
    }
    if (process.env.RENDER === 'true' && !telegramSetup.signal.aborted) {
      await registerWebhook(config, bot.api, logger);
    }
    if (!migrationRequired && !telegramSetup.signal.aborted) await pinned.update();
  }, telegramSetup.signal).catch((error: unknown) => {
    if (!telegramSetup.signal.aborted) logger.error({ event: 'telegram_setup_failed', ...safeError(error) });
  });
}

main().catch((error: unknown) => {
  logger.error({ event: 'startup_failed', stage: startupStage, ...safeError(error) }, 'Не удалось запустить бота. Проверьте конфигурацию и доступ к внешним сервисам.');
  process.exitCode = 1;
});
