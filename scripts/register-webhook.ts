import { pathToFileURL } from 'node:url';
import { Bot } from 'grammy';
import type { Api } from 'grammy';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { createLogger, logOperation, safeError, silentLogger } from '../src/logging.js';
import type { AppLogger } from '../src/logging.js';
import { BOT_DESCRIPTION } from '../src/bot/formatting.js';
import { registerGroupCommands } from '../src/bot/setup.js';

export async function registerWebhook(config: Config, api: Pick<Api, 'setMyCommands' | 'setWebhook' | 'setMyDescription'>, logger: AppLogger = silentLogger): Promise<void> {
  const webhookUrl = new URL('/telegram/webhook', config.PUBLIC_BASE_URL).toString();
  await logOperation(logger, 'telegram_webhook_register', () => api.setWebhook(webhookUrl, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    max_connections: 1, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  }));
  await logOperation(logger, 'telegram_description_register', () => api.setMyDescription(BOT_DESCRIPTION));
  await logOperation(logger, 'telegram_description_ru_register', () => api.setMyDescription(BOT_DESCRIPTION, { language_code: 'ru' }));
  await registerGroupCommands(api, config.TELEGRAM_GROUP_ID, logger);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = createLogger();
  logger.info({ event: 'webhook_setup_started' });
  Promise.resolve().then(async () => {
    const config = loadConfig();
    await registerWebhook(config, new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 10 } }).api, logger);
    logger.info({ event: 'webhook_setup_completed' }, 'Webhook настроен.');
  }).catch((error: unknown) => {
    logger.error({ event: 'webhook_setup_failed', ...safeError(error) }, 'Не удалось зарегистрировать webhook. Проверьте конфигурацию и доступность Telegram.');
    process.exitCode = 1;
  });
}
