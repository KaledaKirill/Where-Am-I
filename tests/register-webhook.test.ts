import { expect, it, vi } from 'vitest';
import { registerWebhook } from '../scripts/register-webhook.js';
import { loadConfig } from '../src/config.js';
import { env } from './fixtures.js';
import { BOT_DESCRIPTION } from '../src/bot/formatting.js';
import { GrammyError } from 'grammy';
import { captureLogs } from './logging-fixture.js';

it('registers commands in the target group and a protected serial webhook without dropping updates', async () => {
  const api = { setMyCommands: vi.fn().mockResolvedValue(true), setWebhook: vi.fn().mockResolvedValue(true), setMyDescription: vi.fn().mockResolvedValue(true) };
  await registerWebhook(loadConfig(env), api);
  expect(api.setMyCommands).toHaveBeenCalledTimes(8);
  expect(api.setMyCommands.mock.calls.at(-2)?.[1]).toEqual({ scope: { type: 'chat', chat_id: '-100123' }, language_code: 'ru' });
  expect(api.setMyCommands.mock.calls.at(-1)?.[1]).toEqual({ scope: { type: 'chat', chat_id: '-100123' } });
  for (const [commands] of api.setMyCommands.mock.calls) expect(commands.map((c: { command: string }) => c.command)).not.toContain('set');
  expect(api.setMyDescription).toHaveBeenCalledWith(BOT_DESCRIPTION);
  expect(api.setMyDescription).toHaveBeenCalledWith(BOT_DESCRIPTION, { language_code: 'ru' });
  expect(api.setWebhook).toHaveBeenCalledWith('https://where-am-i.onrender.com/telegram/webhook', {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET, max_connections: 1, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  });
  expect(api.setWebhook.mock.invocationCallOrder[0]).toBeLessThan(api.setMyCommands.mock.invocationCallOrder[0]!);
});

it('allows deployment before joining the group, logging menu failures only as warnings', async () => {
  const error = new GrammyError('setMyCommands', { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'setMyCommands', {});
  const api = { setMyCommands: vi.fn().mockImplementation((_commands, options) => options.scope.type === 'chat' ? Promise.reject(error) : Promise.resolve(true)), setWebhook: vi.fn().mockResolvedValue(true), setMyDescription: vi.fn().mockResolvedValue(true) };
  const capture = captureLogs();
  await expect(registerWebhook(loadConfig(env), api, capture.logger)).resolves.toBeUndefined();
  expect(api.setWebhook).toHaveBeenCalledTimes(1);
  expect(api.setMyDescription).toHaveBeenCalledTimes(2);
  expect(api.setMyCommands).toHaveBeenCalledTimes(8);
  const failures = capture.records.filter((record) => String(record.event).endsWith('_failed'));
  expect(failures).toHaveLength(2);
  expect(failures.every((record) => record.level === 40 && record.telegram_reason === 'chat_not_found')).toBe(true);
});

it('does not hide webhook registration failures or proceed to optional menus', async () => {
  const error = new Error('Telegram unavailable');
  const api = { setMyCommands: vi.fn(), setWebhook: vi.fn().mockRejectedValue(error), setMyDescription: vi.fn() };
  await expect(registerWebhook(loadConfig(env), api)).rejects.toBe(error);
  expect(api.setMyCommands).not.toHaveBeenCalled();
  expect(api.setMyDescription).not.toHaveBeenCalled();
});
