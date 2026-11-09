import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { BotError, GrammyError, HttpError } from 'grammy';
import { LocationError } from './domain/models.js';

export type AppLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
export const silentLogger = pino({ enabled: false });
const levels = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
const telegramReasons = new Map([
  ['bad request: chat not found', 'chat_not_found'],
  ['bad request: chat_id_invalid', 'chat_id_invalid'],
  ['bad request: group chat was upgraded to a supergroup chat', 'group_migrated'],
  ['bad request: chat_admin_required', 'chat_admin_required'],
  ['bad request: bot_command_invalid', 'invalid_command'],
  ['bad request: bot_command_description_invalid', 'invalid_command_description'],
  ['bad request: language_code_invalid', 'invalid_language_code'],
  ['forbidden: bot was kicked from the group chat', 'bot_kicked'],
  ['forbidden: bot was kicked from the supergroup chat', 'bot_kicked'],
  ['forbidden: bot is not a member of the supergroup chat', 'bot_not_member'],
]);

export function createLogger(level: unknown = process.env.LOG_LEVEL, destination?: DestinationStream): Logger {
  return pino({
    level: typeof level === 'string' && levels.has(level) ? level : 'info',
    base: { service: 'where-am-i' }, timestamp: pino.stdTimeFunctions.isoTime,
    // Defense in depth; application events use allowlisted metadata only.
    redact: { paths: ['token', 'private_key', 'authorization', 'headers', 'req.headers', 'body', 'payload'], censor: '[REDACTED]' },
    hooks: {
      // Sanitize BEFORE Pino can derive `msg` from err.message.
      logMethod(args, method) {
        const value = args[0];
        if (value instanceof Error) args[0] = { err: safeError(value) };
        else if (typeof value === 'object' && value !== null) {
          const record = { ...value } as Record<string, unknown>;
          for (const key of ['err', 'error']) if (key in record) record[key] = safeError(record[key]);
          args[0] = record;
        }
        method.apply(this, args);
      },
    },
  }, destination);
}

/** Do not serialize SDK errors: messages, stacks, URLs and causes may contain credentials. */
export function safeError(error: unknown, depth = 0): Record<string, string | number | string[]> {
  if (depth > 4) return { error_type: 'unknown' };
  if (error instanceof BotError || error instanceof HttpError) return safeError(error.error, depth + 1);
  const fields: Record<string, string | number | string[]> = {
    error_type: error instanceof LocationError ? 'LocationError' : error instanceof GrammyError ? 'TelegramApiError' : 'Error',
  };
  if (error instanceof LocationError) fields.error_code = error.code;
  if (error instanceof GrammyError) {
    const reason = telegramReasons.get(error.description.toLowerCase());
    if (reason) fields.telegram_reason = reason;
  }
  if (typeof error !== 'object' || error === null) return fields;
  const value = error as Record<string, unknown>;
  if (value.name === 'AbortError' || value.name === 'TimeoutError' || value.name === 'SyntaxError') fields.error_type = value.name;
  if (typeof value.code === 'string' && networkCodes.has(value.code)) fields.error_code = value.code;
  const response = typeof value.response === 'object' && value.response !== null ? value.response as Record<string, unknown> : {};
  const status = value.error_code ?? value.statusCode ?? value.status ?? response.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) fields.http_status = status;
  if (value.cause !== undefined && value.cause !== error) {
    const cause = safeError(value.cause, depth + 1);
    fields.cause_type = String(cause.error_type);
    if (cause.error_code ?? cause.cause_code) fields.cause_code = String(cause.error_code ?? cause.cause_code);
    if (cause.http_status) fields.http_status = Number(cause.http_status);
  }
  // Map known internal diagnostics to fixed codes, never copy arbitrary text.
  if (error instanceof Error) {
    if (error.message.startsWith('Некорректная конфигурация:')) {
      fields.error_code = 'invalid_configuration';
      fields.invalid_fields = (error.message.split(':')[1] ?? '').split(',').map((key) => key.trim())
        .filter((key) => /^(NODE_ENV|LOG_LEVEL|PORT|PUBLIC_BASE_URL|TELEGRAM_BOT_TOKEN|TELEGRAM_GROUP_ID|TELEGRAM_WEBHOOK_SECRET|GOOGLE_SPREADSHEET_ID|GOOGLE_SERVICE_ACCOUNT_EMAIL|GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY|NOMINATIM_USER_AGENT|NOMINATIM_BASE_URL)$/.test(key));
    } else if (error.message.startsWith('Несовместимые заголовки листа ')) fields.error_code = 'incompatible_sheet_headers';
    else if (/^Лист (Users|LocationHistory) содержит данные без заголовков/.test(error.message)) fields.error_code = 'missing_sheet_headers';
    else if (error.message === 'Некорректные или повторные записи Users') fields.error_code = 'invalid_user_rows';
    else if (error.message === 'Некорректный ответ Nominatim') fields.error_code = 'invalid_nominatim_response';
  }
  return fields;
}

export async function logOperation<T>(logger: AppLogger, event: string, operation: () => Promise<T>, level: 'debug' | 'info' = 'info', failureLevel: 'warn' | 'error' = 'error'): Promise<T> {
  const started = performance.now();
  logger.debug({ event: `${event}_started` });
  try {
    const result = await operation();
    logger[level]({ event: `${event}_completed`, duration_ms: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    logger[failureLevel]({ event: `${event}_failed`, ...safeError(error), duration_ms: Math.round(performance.now() - started) });
    throw error;
  }
}
