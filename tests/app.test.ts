import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { env } from './fixtures.js';
import { botFixture, locationUpdate } from './bot-fixture.js';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup() {
  const f = botFixture();
  const app = createApp(loadConfig(env), f.service, f.bot);
  apps.push(app);
  return { ...f, app };
}

describe('HTTP application', () => {
  it('serves health without any external access', async () => {
    const f = setup();
    const read = vi.spyOn(f.repo, 'listUsers');
    const response = await f.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-app-version']).toBe('3.0');
    expect(read).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([undefined, 'wrong', 'xxxxxxxxxxx'])('rejects webhook secret %j before handling updates', async (secret) => {
    const f = setup();
    const response = await f.app.inject({ method: 'POST', url: '/telegram/webhook',
      headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {},
      payload: locationUpdate(),
    });
    expect(response.statusCode).toBe(403);
    expect(f.repo.history).toHaveLength(0);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('handles an authorized Telegram update through the official adapter', async () => {
    const f = setup();
    const response = await f.app.inject({ method: 'POST', url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET },
      payload: locationUpdate(),
    });
    expect(response.statusCode).toBe(200);
    expect(f.repo.history).toHaveLength(1);
    expect(f.calls.at(-1)?.payload.text).toContain('Вы отметились');
  });

  it('returns a safe 400 for a malformed webhook body', async () => {
    const f = setup();
    const response = await f.app.inject({ method: 'POST', url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET }, payload: { private_key: 'secret' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('secret');
    expect(f.transport).not.toHaveBeenCalled();
  });
});
