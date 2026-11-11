import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { env } from './fixtures.js';

it('validates configuration and restores key newlines', () => {
  expect(loadConfig(env).GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).toContain('\ntest\n');
  expect(loadConfig(env).PORT).toBe(3000);
  expect(loadConfig(env).LOG_LEVEL).toBe('info');
});

it.each([
  { LOG_LEVEL: 'verbose' }, { PORT: '0' }, { PUBLIC_BASE_URL: 'http://host' }, { TELEGRAM_GROUP_ID: '123' },
  { TELEGRAM_WEBHOOK_SECRET: 'bad secret' }, { GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'secret' },
  { GEOAPIFY_API_KEY: '' },
])('rejects invalid config without leaking its values: %j', (override) => {
  expect(() => loadConfig({ ...env, ...override })).toThrow('Некорректная конфигурация');
  try { loadConfig({ ...env, ...override }); }
  catch (error) { expect(String(error)).not.toContain('fake_token'); }
});
