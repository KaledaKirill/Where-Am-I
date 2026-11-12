import type { Api } from 'grammy';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

export const GROUP_COMMANDS = [{ command: 'list', description: 'Где сейчас путешественники' }];
export const PRIVATE_COMMANDS = [
  { command: 'start', description: 'Отметиться и узнать, как пользоваться ботом' },
  { command: 'help', description: 'Как пользоваться ботом' },
  ...GROUP_COMMANDS,
  { command: 'find', description: 'Найти путешественников' },
  { command: 'destination', description: 'Изменить планы поездки' },
  { command: 'cancel', description: 'Отменить текущий ввод' },
];

export async function registerGroupCommands(api: Pick<Api, 'setMyCommands'>, groupId: string, logger: AppLogger = silentLogger): Promise<void> {
  for (const language of ['ru', ''] as const) {
    try {
      await logOperation(logger, language ? 'telegram_commands_ru_register' : 'telegram_commands_register', () => api.setMyCommands(GROUP_COMMANDS, {
        scope: { type: 'chat', chat_id: groupId }, ...(language ? { language_code: language } : {}),
      }), 'info', 'warn');
    } catch { /* Group menu can be installed when the bot joins later. */ }
  }
}

export async function registerPrivateCommands(api: Pick<Api, 'setMyCommands'>): Promise<void> {
  for (const language of ['ru', ''] as const) {
    const options = language ? { language_code: language } : {};
    await api.setMyCommands([], { scope: { type: 'default' }, ...options });
    await api.setMyCommands([], { scope: { type: 'all_group_chats' }, ...options });
    await api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' }, ...options });
  }
}
