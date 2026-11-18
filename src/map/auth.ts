import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const telegramUser = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.literal(false).optional() });

function equal(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function mapAuth(botToken: string, now = Date.now) {
  const telegramKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const sessionKey = createHmac('sha256', botToken).update('where-am-i/map/session/v1').digest();

  return {
    verifyLaunch(initData: string): number | null {
      const fields = new URLSearchParams(initData);
      if (new Set(fields.keys()).size !== fields.size) return null;
      const hash = fields.get('hash') ?? '';
      if (!/^[a-f\d]{64}$/i.test(hash)) return null;
      fields.delete('hash');
      fields.sort();
      const check = [...fields].map(([key, value]) => `${key}=${value}`).join('\n');
      const expected = createHmac('sha256', telegramKey).update(check).digest();
      if (!equal(Buffer.from(hash, 'hex'), expected)) return null;
      const date = fields.get('auth_date') ?? '';
      if (!/^\d{1,12}$/.test(date)) return null;
      const age = now() - Number(date) * 1000;
      if (age > 5 * 60_000 || age < -30_000) return null;
      try {
        const user = telegramUser.safeParse(JSON.parse(fields.get('user') ?? 'null'));
        return user.success ? user.data.id : null;
      } catch { return null; }
    },
    issue(userId: number): string {
      const payload = `${userId}.${now() + 60 * 60_000}`;
      return `${payload}.${createHmac('sha256', sessionKey).update(payload).digest('base64url')}`;
    },
    verifySession(authorization: string | undefined): number | null {
      const match = authorization?.match(/^Bearer ([1-9]\d{0,15})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/);
      if (!match) return null;
      const [, id, expires, signature] = match;
      const userId = Number(id);
      if (!Number.isSafeInteger(userId) || Number(expires) <= now()) return null;
      const expected = createHmac('sha256', sessionKey).update(`${id}.${expires}`).digest('base64url');
      return equal(Buffer.from(signature!), Buffer.from(expected)) ? userId : null;
    },
  };
}
