import type { Api } from 'grammy';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

const commands = [
  { command: 'set', description: 'Отметить город и страну' },
  { command: 'list', description: 'Список отметившихся по городам' },
  { command: 'me', description: 'Моя последняя отметка' },
  { command: 'help', description: 'Как пользоваться ботом' },
  { command: 'start', description: 'Как пользоваться ботом' },
];

/** Chat-scoped menus can be configured after deployment, when the bot joins. */
export async function registerGroupCommands(api: Pick<Api, 'setMyCommands'>, groupId: string, logger: AppLogger = silentLogger): Promise<void> {
  for (const language of ['ru', ''] as const) {
    const event = language ? 'telegram_commands_ru_register' : 'telegram_commands_register';
    try {
      await logOperation(logger, event, () => api.setMyCommands(commands, {
        scope: { type: 'chat', chat_id: groupId }, ...(language ? { language_code: language } : {}),
      }), 'info', 'warn');
    } catch {
      // The warning above is sufficient: menu availability must not block the bot.
    }
  }
}
