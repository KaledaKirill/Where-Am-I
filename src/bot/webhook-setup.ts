import type { Api } from 'grammy';
import type { Config } from '../config.js';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';
import { BOT_DESCRIPTION } from './formatting.js';
import { registerGroupCommands, registerPrivateCommands } from './setup.js';

export async function registerWebhook(config: Config, api: Pick<Api, 'setMyCommands' | 'setWebhook' | 'setMyDescription'>, logger: AppLogger = silentLogger): Promise<void> {
  const webhookUrl = new URL('/telegram/webhook', config.PUBLIC_BASE_URL).toString();
  await logOperation(logger, 'telegram_webhook_register', () => api.setWebhook(webhookUrl, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    max_connections: 1, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  }));
  await logOperation(logger, 'telegram_description_register', () => api.setMyDescription(BOT_DESCRIPTION));
  await logOperation(logger, 'telegram_description_ru_register', () => api.setMyDescription(BOT_DESCRIPTION, { language_code: 'ru' }));
  await registerPrivateCommands(api);
  await registerGroupCommands(api, config.TELEGRAM_GROUP_ID, logger);
}
