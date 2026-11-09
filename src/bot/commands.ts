import { Bot, GrammyError } from 'grammy';
import type { Context } from 'grammy';
import { LocationError } from '../domain/models.js';
import type { LocationService } from '../services/location-service.js';
import { HELP_TEXT, placeLabel } from './formatting.js';
import { parsePage, renderListPage } from './pagination.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';
import { registerGroupCommands } from './setup.js';

export function errorText(error: unknown): string {
  if (!(error instanceof LocationError)) return 'Сервис временно недоступен. Попробуйте немного позже.';
  switch (error.code) {
    case 'empty_input': return 'Укажите город и страну. Например: /set Берлин, Германия';
    case 'invalid_input': return 'Укажите только населённый пункт и страну, без адреса, ссылок и координат (до 120 символов).';
    case 'not_found': return 'Не удалось найти город. Попробуйте /set Берлин, Германия';
    case 'ambiguous': return 'Найдено несколько возможных мест. Уточните город, страну или регион в новой команде /set.';
    case 'unavailable': return 'Сервис временно недоступен. Попробуйте немного позже.';
  }
}

function allowedChat(ctx: Context, groupId: string): boolean {
  return !!ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type) && String(ctx.chat.id) === groupId;
}

export function registerCommands(bot: Bot, service: LocationService, groupId: string, logger: AppLogger = silentLogger): void {
  const logFailure = (ctx: Context, action: string, error: unknown) => {
    const expected = error instanceof LocationError && error.code !== 'unavailable';
    logger[expected ? 'warn' : 'error']({
      event: expected ? 'command_rejected' : 'command_failed', action, update_id: ctx.update.update_id, ...safeError(error),
    });
  };
  bot.use(async (ctx, next) => {
    if (!allowedChat(ctx, groupId)) {
      logger.warn({ event: 'telegram_access_denied', update_id: ctx.update.update_id, reason: 'unauthorized_chat' });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }
    const started = performance.now();
    logger.debug({ event: 'telegram_update_received', update_id: ctx.update.update_id });
    try {
      await next();
      logger.debug({ event: 'telegram_update_handled', update_id: ctx.update.update_id, duration_ms: Math.round(performance.now() - started) });
    } catch (error) {
      logger.error({ event: 'telegram_update_failed', update_id: ctx.update.update_id, ...safeError(error), duration_ms: Math.round(performance.now() - started) });
      throw error;
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const { old_chat_member: previous, new_chat_member: current } = ctx.myChatMember;
    if (['left', 'kicked'].includes(previous.status) && ['member', 'administrator'].includes(current.status)) {
      logger.info({ event: 'bot_added_to_group', update_id: ctx.update.update_id });
      await registerGroupCommands(ctx.api, groupId, logger);
    }
  });

  bot.command(['help', 'start'], async (ctx) => {
    await ctx.reply(HELP_TEXT);
    logger.info({ event: 'help_shown', update_id: ctx.update.update_id });
  });

  bot.command('set', async (ctx) => {
    if (ctx.message?.sender_chat || !ctx.from || ctx.from.is_bot || !Number.isSafeInteger(ctx.from.id) || ctx.from.id <= 0) {
      logger.warn({ event: 'command_rejected', action: 'set', update_id: ctx.update.update_id, reason: 'invalid_sender' });
      await ctx.reply('Отметиться можно только от своего пользовательского профиля.');
      return;
    }
    try {
      const user = await service.setLocation({
        user_id: String(ctx.from.id),
        display_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        username: ctx.from.username ?? null,
      }, ctx.match);
      logger.info({ event: 'location_saved', update_id: ctx.update.update_id });
      await ctx.reply(`✅ Отметка сохранена: ${placeLabel(user)}`, { parse_mode: 'HTML' });
    } catch (error) { logFailure(ctx, 'set', error); await ctx.reply(errorText(error)); }
  });

  bot.command('me', async (ctx) => {
    if (ctx.message?.sender_chat || !ctx.from || ctx.from.is_bot) return;
    try {
      const user = await service.getMe(String(ctx.from.id));
      await ctx.reply(user ? `Ваша последняя отметка: ${placeLabel(user)}\nОбновлено: ${new Date(user.updated_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Minsk' })}`
        : 'У вас пока нет отметки. Напишите /set Город, Страна', { parse_mode: 'HTML' });
      logger.info({ event: 'location_shown', update_id: ctx.update.update_id, found: user !== null });
    } catch (error) { logFailure(ctx, 'me', error); await ctx.reply(errorText(error)); }
  });

  bot.command('list', async (ctx) => {
    try {
      const page = renderListPage(await service.listGroups());
      await ctx.reply(page.text, { parse_mode: 'HTML', reply_markup: page.keyboard });
      logger.info({ event: 'list_shown', update_id: ctx.update.update_id, total_pages: page.totalPages });
    } catch (error) { logFailure(ctx, 'list', error); await ctx.reply(errorText(error)); }
  });

  bot.on('callback_query', async (ctx) => {
    let notice: string | undefined;
    try {
      const message = ctx.callbackQuery.message;
      const pageIndex = parsePage(ctx.callbackQuery.data ?? '');
      if (pageIndex === null || !message || !('from' in message) || message.from?.id !== ctx.me.id) {
        logger.warn({ event: 'callback_rejected', update_id: ctx.update.update_id, reason: 'invalid_callback' });
        return;
      }
      const page = renderListPage(await service.listGroups(), pageIndex);
      try {
        await ctx.editMessageText(page.text, { parse_mode: 'HTML', reply_markup: page.keyboard });
      } catch (error) {
        if (!(error instanceof GrammyError && error.error_code === 400 && error.description.includes('message is not modified'))) throw error;
      }
      logger.info({ event: 'list_page_changed', update_id: ctx.update.update_id, page: page.index, total_pages: page.totalPages });
    } catch (error) { logFailure(ctx, 'paginate', error); notice = errorText(error); }
    finally { await ctx.answerCallbackQuery(notice ? { text: notice } : {}); }
  });
}
