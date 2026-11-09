import { describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import { createLogger, logOperation, safeError } from '../src/logging.js';
import { LocationError } from '../src/domain/models.js';
import { loadConfig } from '../src/config.js';
import { registerCommands } from '../src/bot/commands.js';
import { createApp } from '../src/app.js';
import { registerWebhook } from '../scripts/register-webhook.js';
import { botFixture, messageUpdate, callbackUpdate } from './bot-fixture.js';
import { env } from './fixtures.js';
import { captureLogs } from './logging-fixture.js';

const sensitiveError = Object.assign(new Error('private-key token=super-secret https://user:password@host/path'), {
  config: { headers: { Authorization: 'Bearer super-secret' }, data: 'private-key' },
  response: { status: 503, data: { private_key: 'private-key' } },
});

describe('safe structured logging', () => {
  it('preserves useful diagnostics through wrapped errors without copying SDK payloads', () => {
    const result = safeError(new LocationError('unavailable', { cause: sensitiveError }));
    expect(result).toMatchObject({ error_type: 'LocationError', error_code: 'unavailable', http_status: 503 });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(safeError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toMatchObject({ cause_code: 'ENOTFOUND' });
    const cyclic = new Error('secret');
    cyclic.cause = cyclic;
    expect(() => safeError(cyclic)).not.toThrow();
    expect(safeError('super-secret')).toEqual({ error_type: 'Error' });
    expect(safeError({ name: 'super-secret', code: 'private-key' })).toEqual({ error_type: 'Error' });
    expect(safeError(new GrammyError('secret', { ok: false, error_code: 429, description: 'private-key' }, 'sendMessage', {})))
      .toMatchObject({ error_type: 'TelegramApiError', http_status: 429 });
  });

  it('reports configuration field names without their values', () => {
    let error: unknown;
    try { loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 'super-secret' }); } catch (caught) { error = caught; }
    expect(safeError(error)).toMatchObject({ error_code: 'invalid_configuration', invalid_fields: ['TELEGRAM_BOT_TOKEN'] });
    expect(JSON.stringify(safeError(error))).not.toContain('super-secret');
  });

  it('respects levels, includes timestamps and applies serializers and redaction', () => {
    const capture = captureLogs('info');
    capture.logger.debug({ event: 'hidden' });
    capture.logger.error({ event: 'failure', err: sensitiveError, token: 'super-secret', body: { private_key: 'private-key' } });
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({ event: 'failure', token: '[REDACTED]', service: 'where-am-i' });
    expect(capture.records[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(capture.output()).not.toContain('super-secret');
    expect(capture.output()).not.toContain('private-key');
    capture.logger.error(sensitiveError);
    expect(capture.output()).not.toContain('super-secret');
    expect(capture.output()).not.toContain('private-key');
    const silent = captureLogs('silent');
    silent.logger.error({ event: 'hidden' });
    expect(silent.records).toHaveLength(0);
    expect(createLogger('bad-level').level).toBe('info');
  });

  it('logs failed operations with duration and rethrows the same error without retry', async () => {
    const capture = captureLogs();
    const operation = vi.fn().mockRejectedValue(sensitiveError);
    await expect(logOperation(capture.logger, 'test_operation', operation)).rejects.toBe(sensitiveError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(capture.records.at(-1)).toMatchObject({ event: 'test_operation_failed', http_status: 503, duration_ms: expect.any(Number) });
    expect(capture.output()).not.toContain('super-secret');
  });
});

describe('important application events', () => {
  it('logs actual saves, command failures and denied access without user data', async () => {
    const f = botFixture();
    const capture = captureLogs();
    registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID, capture.logger);
    await f.bot.handleUpdate(messageUpdate('/set Берлин, Германия'));
    await f.bot.handleUpdate(messageUpdate('/list'));
    await f.bot.handleUpdate(messageUpdate('/me'));
    await f.bot.handleUpdate(messageUpdate('/help'));
    await f.bot.handleUpdate(callbackUpdate('list:0'));
    await f.bot.handleUpdate(messageUpdate('/set'));
    await f.bot.handleUpdate(messageUpdate('/list', -999));
    vi.spyOn(f.repo, 'saveLocation').mockRejectedValue(sensitiveError);
    await f.bot.handleUpdate(messageUpdate('/set Берлин, Германия'));
    expect(capture.records.filter((line) => line.event === 'location_saved')).toHaveLength(1);
    expect(capture.records.map((line) => line.event)).toEqual(expect.arrayContaining([
      'list_shown', 'location_shown', 'help_shown', 'list_page_changed', 'command_rejected', 'telegram_access_denied', 'command_failed',
    ]));
    expect(capture.records.find((line) => line.event === 'command_failed')).toMatchObject({ action: 'set', update_id: 1, http_status: 503 });
    for (const secret of ['Берлин', 'Германия', 'Анна', 'anna', '1001', 'super-secret', 'private-key']) expect(capture.output()).not.toContain(secret);
  });

  it('logs Telegram delivery failures after a confirmed save', async () => {
    const f = botFixture();
    const capture = captureLogs();
    registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID, capture.logger);
    f.transport.mockRejectedValue(sensitiveError);
    await expect(f.bot.handleUpdate(messageUpdate('/set Берлин'))).rejects.toThrow();
    expect(capture.records.map((line) => line.event)).toEqual(expect.arrayContaining(['location_saved', 'command_failed', 'telegram_update_failed']));
    expect(capture.output()).not.toContain('super-secret');
    expect(f.repo.history).toHaveLength(1);
  });

  it('logs rejected webhook requests but keeps health checks and request bodies out of logs', async () => {
    const f = botFixture();
    const capture = captureLogs();
    const app = createApp(loadConfig(env), f.service, f.bot, capture.logger);
    try {
      await app.inject({ method: 'GET', url: '/health' });
      expect(capture.records).toHaveLength(0);
      await app.inject({ method: 'POST', url: '/telegram/webhook?token=super-secret', headers: { 'x-telegram-bot-api-secret-token': 'private-key' }, payload: messageUpdate('/set Берлин') });
      expect(capture.records).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'webhook_rejected', level: 40 })]));
      for (const secret of ['super-secret', 'private-key', 'Берлин', 'Анна']) expect(capture.output()).not.toContain(secret);
    } finally { await app.close(); }
  });

  it('logs setup failures without exposing tokens or setup arguments', async () => {
    const capture = captureLogs();
    const api = { setMyCommands: vi.fn().mockResolvedValue(true), setWebhook: vi.fn().mockRejectedValue(sensitiveError), setMyDescription: vi.fn().mockResolvedValue(true) };
    await expect(registerWebhook(loadConfig(env), api, capture.logger)).rejects.toBe(sensitiveError);
    expect(capture.records.at(-1)).toMatchObject({ event: 'telegram_webhook_register_failed', http_status: 503 });
    for (const secret of [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, 'super-secret']) expect(capture.output()).not.toContain(secret);
  });
});
