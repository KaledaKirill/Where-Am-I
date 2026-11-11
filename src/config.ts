import { z } from 'zod';

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'Требуется HTTPS URL');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: httpsUrl,
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  TELEGRAM_GROUP_ID: z.string().regex(/^-\d+$/),
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  GOOGLE_SPREADSHEET_ID: z.string().regex(/^[A-Za-z0-9_-]+$/),
  GEOAPIFY_API_KEY: z.string().trim().min(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.email(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().transform((value) => value.replace(/\\n/g, '\n'))
    .refine((value) => value.includes('-----BEGIN PRIVATE KEY-----') && value.includes('-----END PRIVATE KEY-----'), 'Некорректный PEM ключ'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Report variable names only: Zod issues or raw errors may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Некорректная конфигурация: ${fields.join(', ')}`);
  }
  return result.data;
}
