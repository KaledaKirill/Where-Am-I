import { expect, it, vi } from 'vitest';
import { registerWebhook } from '../scripts/register-webhook.js';
import { loadConfig } from '../src/config.js';
import { env } from './fixtures.js';
import { BOT_DESCRIPTION } from '../src/bot/formatting.js';

it('registers commands in the target group and a protected serial webhook without dropping updates', async () => {
  const api = { setMyCommands: vi.fn().mockResolvedValue(true), setWebhook: vi.fn().mockResolvedValue(true), setMyDescription: vi.fn().mockResolvedValue(true) };
  await registerWebhook(loadConfig(env), api);
  expect(api.setMyCommands).toHaveBeenCalledTimes(2);
  expect(api.setMyCommands.mock.calls[0]?.[1]).toEqual({ scope: { type: 'chat', chat_id: '-100123' }, language_code: 'ru' });
  expect(api.setMyCommands.mock.calls[1]?.[1]).toEqual({ scope: { type: 'chat', chat_id: '-100123' } });
  expect(api.setMyDescription).toHaveBeenCalledWith(BOT_DESCRIPTION);
  expect(api.setMyDescription).toHaveBeenCalledWith(BOT_DESCRIPTION, { language_code: 'ru' });
  expect(api.setWebhook).toHaveBeenCalledWith('https://where-am-i.onrender.com/telegram/webhook', {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET, max_connections: 1, allowed_updates: ['message', 'callback_query'],
  });
});
