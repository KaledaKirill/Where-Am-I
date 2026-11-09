import { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createGoogleSheetsRepository } from './adapters/google-sheets-repository.js';
import { NominatimPlaceResolver } from './adapters/nominatim-place-resolver.js';
import { LocationService } from './services/location-service.js';
import { createLogger, logOperation, safeError } from './logging.js';

const logger = createLogger();
let startupStage = 'configuration';

async function main(): Promise<void> {
  logger.info({ event: 'app_starting' });
  const config = loadConfig();
  startupStage = 'sheets_initialize';
  const repository = createGoogleSheetsRepository(config, logger.child({ component: 'google_sheets' }));
  await repository.initialize();
  const service = new LocationService(repository, new NominatimPlaceResolver(config.NOMINATIM_USER_AGENT, config.NOMINATIM_BASE_URL, undefined, logger.child({ component: 'nominatim' })));
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } });
  startupStage = 'telegram_initialize';
  await logOperation(logger, 'telegram_initialize', () => bot.init());
  const app = createApp(config, service, bot, logger);
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
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
}

main().catch((error: unknown) => {
  logger.error({ event: 'startup_failed', stage: startupStage, ...safeError(error) }, 'Не удалось запустить бота. Проверьте конфигурацию и доступ к внешним сервисам.');
  process.exitCode = 1;
});
