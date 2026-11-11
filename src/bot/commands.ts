import { Bot, Keyboard } from 'grammy';
import type { Context } from 'grammy';
import { LocationError } from '../domain/models.js';
import type { LocationService } from '../services/location-service.js';
import type { PinnedMessageService } from '../services/pinned-message-service.js';
import { checkListLength, formatList, HELP_TEXT, ListTooLongError, placeLabel, START_TEXT } from './formatting.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';
import { registerGroupCommands } from './setup.js';

export function errorText(error: unknown): string {
  if (error instanceof ListTooLongError) return 'Список превышает лимит сообщения Telegram. Ошибка записана в журнал.';
  if (error instanceof LocationError && error.code === 'geocoding_failed') return 'Не удалось определить местоположение. Попробуйте отправить геолокацию позже.';
  if (error instanceof LocationError && error.code === 'invalid_input') return 'Не удалось прочитать координаты. Отправьте геолокацию ещё раз.';
  return 'Сервис временно недоступен. Попробуйте немного позже.';
}

export function registerCommands(bot: Bot, service: LocationService, groupId: string, logger: AppLogger = silentLogger, pinned?: Pick<PinnedMessageService, 'update'>): void {
  const logFailure = (ctx: Context, action: string, error: unknown) => logger.error({ event: 'command_failed', action, update_id: ctx.update.update_id, ...safeError(error) });
  const keyboard = () => new Keyboard().requestLocation('📍 Отправить геолокацию').resized();
  const member = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat || !Number.isSafeInteger(ctx.from.id) || ctx.from.id <= 0) return false;
    const membership = await ctx.api.getChatMember(groupId, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(membership.status) || (membership.status === 'restricted' && membership.is_member);
  };

  bot.use(async (ctx, next) => {
    if (!ctx.chat || !(ctx.chat.type === 'private' || (['group', 'supergroup'].includes(ctx.chat.type) && String(ctx.chat.id) === groupId))) {
      logger.warn({ event: 'telegram_access_denied', update_id: ctx.update.update_id, reason: 'unauthorized_chat' });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }
    try { await next(); }
    catch (error) { logger.error({ event: 'telegram_update_failed', update_id: ctx.update.update_id, ...safeError(error) }); throw error; }
  });

  bot.on('my_chat_member', async (ctx) => {
    const { old_chat_member: previous, new_chat_member: current } = ctx.myChatMember;
    if (String(ctx.chat.id) === groupId && ['left', 'kicked'].includes(previous.status) && ['member', 'administrator'].includes(current.status)) {
      await registerGroupCommands(ctx.api, groupId, logger);
    }
  });

  bot.command(['help', 'start'], async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply(ctx.message?.text?.startsWith('/start') ? START_TEXT : HELP_TEXT, { reply_markup: keyboard() });
    logger.info({ event: 'help_shown', update_id: ctx.update.update_id });
  });

  bot.on('message:location', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    try {
      if (!await member(ctx)) {
        await ctx.reply('Отметиться могут только участники нашей группы.');
        return;
      }
      const user = await service.setLocation({ user_id: String(ctx.from.id), display_name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), username: ctx.from.username ?? null }, ctx.message.location);
      logger.info({ event: 'location_saved', update_id: ctx.update.update_id });
      await pinned?.update();
      await ctx.reply(`✅ Вы отметились: ${placeLabel(user)}`, { parse_mode: 'HTML' });
    } catch (error) { logFailure(ctx, 'location', error); await ctx.reply(errorText(error)); }
  });

  bot.command('list', async (ctx) => {
    try {
      if (ctx.chat.type === 'private' && !await member(ctx)) {
        await ctx.reply('Список доступен только участникам нашей группы.');
        return;
      }
      const text = formatList(await service.listGroups());
      checkListLength(text);
      await ctx.reply(text, { parse_mode: 'HTML' });
      logger.info({ event: 'list_shown', update_id: ctx.update.update_id });
    } catch (error) { logFailure(ctx, 'list', error); await ctx.reply(errorText(error)); }
  });

  // Acknowledge buttons on old messages without retaining the removed paging UI.
  bot.on('callback_query', (ctx) => ctx.answerCallbackQuery());
}
