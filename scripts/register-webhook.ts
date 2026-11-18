import { pathToFileURL } from 'node:url';
import { Bot } from 'grammy';
import { loadConfig } from '../src/config.js';
import { createLogger, safeError } from '../src/logging.js';
import { registerWebhook } from '../src/bot/webhook-setup.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = createLogger();
  void (async () => {
    // Older Render start commands still invoke this script before starting HTTP.
    if (process.env.RENDER === 'true' && !process.argv.includes('--manual')) {
      logger.info({ event: 'webhook_setup_delegated_to_server' });
      return;
    }
    logger.info({ event: 'webhook_setup_started' });
    const config = loadConfig();
    await registerWebhook(config, new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } }).api, logger);
    logger.info({ event: 'webhook_setup_completed' }, 'Webhook настроен.');
  })().catch((error: unknown) => {
    logger.error({ event: 'webhook_setup_failed', ...safeError(error) }, 'Не удалось зарегистрировать webhook. Проверьте конфигурацию и доступность Telegram.');
    process.exitCode = 1;
  });
}
