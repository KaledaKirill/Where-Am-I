import { randomBytes } from 'node:crypto';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import type { Context } from 'grammy';
import { LocationError } from '../domain/models.js';
import type { CurrentUser, PlaceCandidate, TelegramUser } from '../domain/models.js';
import { locationLabel } from '../domain/geocoder.js';
import type { LocationService } from '../services/location-service.js';
import type { PinnedMessageService } from '../services/pinned-message-service.js';
import { BUTTONS, formatListParts, formatSearch, HELP_TEXT, placeLabel, START_TEXT } from './formatting.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';
import { registerGroupCommands } from './setup.js';

type Mode = 'current' | 'destination' | 'find';
interface Dialog { mode: Mode; token: string; candidates?: PlaceCandidate[] }

export function errorText(error: unknown): string {
  if (error instanceof LocationError) {
    if (error.code === 'geocoding_failed') return 'Не удалось определить местоположение. Попробуйте ещё раз немного позже.';
    if (error.code === 'invalid_input') return 'Не удалось прочитать место. Отправьте населённый пункт и страну, например: Нижний Новгород Россия. Для поиска можно указать страну или регион.';
    if (error.code === 'not_found') return 'Место не найдено или запрос недостаточно точный. Проверьте написание и добавьте страну, например: Берлин Германия. Попробуйте ещё раз.';
    if (error.code === 'no_location') return 'Сначала отметьте текущее местоположение: отправьте геолокацию или населённый пункт и страну.';
  }
  return 'Сервис временно недоступен. Попробуйте немного позже.';
}

export function registerCommands(bot: Bot, service: LocationService, groupId: string, logger: AppLogger = silentLogger, pinned?: Pick<PinnedMessageService, 'update'>): void {
  const dialogs = new Map<number, Dialog>();
  const queues = new Map<number, Promise<void>>();
  const begin = (id: number, mode: Mode): Dialog => {
    const state = { mode, token: randomBytes(6).toString('hex') };
    dialogs.set(id, state);
    return state;
  };
  const logFailure = (ctx: Context, action: string, error: unknown) => logger.error({ event: 'command_failed', action, update_id: ctx.update.update_id, ...safeError(error) });
  const keyboard = () => new Keyboard().requestLocation(BUTTONS.location).row().text(BUTTONS.text)
    .row().text(BUTTONS.find).text(BUTTONS.destination).row().text(BUTTONS.list).resized();
  const skipKeyboard = (state: Dialog) => new InlineKeyboard().text('Пока никуда не планирую', `place:${state.token}:skip`);
  const member = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat || !Number.isSafeInteger(ctx.from.id) || ctx.from.id <= 0) return false;
    const membership = await ctx.api.getChatMember(groupId, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(membership.status) || (membership.status === 'restricted' && membership.is_member);
  };
  const authorized = async (ctx: Context) => {
    if (await member(ctx)) return true;
    await ctx.reply('Эта возможность доступна только участникам нашей группы.');
    return false;
  };
  const safely = async (ctx: Context, action: string, operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) {
      logFailure(ctx, action, error);
      const state = ctx.from && dialogs.get(ctx.from.id);
      await ctx.reply(errorText(error), state?.mode === 'destination' ? { reply_markup: skipKeyboard(state) } : {});
    }
  };
  const author = (ctx: Context): TelegramUser => ({ user_id: String(ctx.from!.id),
    display_name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' '), username: ctx.from!.username ?? null });
  const askDestination = async (ctx: Context) => {
    const state = begin(ctx.from!.id, 'destination');
    await ctx.reply('✈️ Куда направляешься?\nНапишите населённый пункт и страну, например: Берлин Германия.\n/cancel — отменить ввод без изменения сохранённых планов.', { reply_markup: skipKeyboard(state) });
  };
  const saved = async (ctx: Context, user: CurrentUser) => {
    // Establish destination mode before sending the confirmation.
    begin(ctx.from!.id, 'destination');
    logger.info({ event: 'location_saved', update_id: ctx.update.update_id });
    try { await pinned?.update(); } catch (error) { logFailure(ctx, 'pin', error); }
    await ctx.reply(`✅ Вы отметились: ${placeLabel(user)}`, { parse_mode: 'HTML' });
    await askDestination(ctx);
  };
  const apply = async (ctx: Context, mode: Mode, candidate: PlaceCandidate) => {
    if (mode === 'current') { await saved(ctx, await service.setTextLocation(author(ctx), candidate)); return; }
    if (mode === 'destination') {
      await service.setDestination(String(ctx.from!.id), candidate);
      dialogs.delete(ctx.from!.id);
      logger.info({ event: 'destination_saved', update_id: ctx.update.update_id });
      await ctx.reply(`✈️ Планы сохранены: ${placeLabel({ location: locationLabel(candidate) })}`, { parse_mode: 'HTML', reply_markup: keyboard() });
      return;
    }
    const result = await service.findTravelers(candidate);
    begin(ctx.from!.id, 'find');
    for (const text of formatSearch(locationLabel(candidate), result)) await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  };

  bot.use(async (ctx, next) => {
    if (!ctx.chat || !(ctx.chat.type === 'private' || (['group', 'supergroup'].includes(ctx.chat.type) && String(ctx.chat.id) === groupId))) {
      logger.warn({ event: 'telegram_access_denied', update_id: ctx.update.update_id, reason: 'unauthorized_chat' });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }
    // Dialog coordination only; webhook deliveries are not deduplicated.
    const id = ctx.chat.type === 'private' ? ctx.from?.id : undefined;
    const previous = id === undefined ? Promise.resolve() : queues.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(next);
    if (id !== undefined) queues.set(id, task);
    try { await task; }
    catch (error) { logger.error({ event: 'telegram_update_failed', update_id: ctx.update.update_id, ...safeError(error) }); throw error; }
    finally { if (id !== undefined && queues.get(id) === task) queues.delete(id); }
  });

  bot.on('my_chat_member', async (ctx) => {
    const { old_chat_member: previous, new_chat_member: current } = ctx.myChatMember;
    const joined = ['left', 'kicked'].includes(previous.status) && ['member', 'administrator'].includes(current.status);
    const promoted = current.status === 'administrator' && previous.status !== 'administrator';
    if (String(ctx.chat.id) === groupId && (joined || promoted)) {
      await registerGroupCommands(ctx.api, groupId, logger);
      if (promoted) await pinned?.update();
    }
  });

  bot.command(['help', 'start'], async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const start = ctx.message!.text!.startsWith('/start');
    if (start) dialogs.delete(ctx.from!.id);
    await ctx.reply(start ? START_TEXT : HELP_TEXT, { reply_markup: keyboard() });
    logger.info({ event: 'help_shown', update_id: ctx.update.update_id });
  });
  bot.command('cancel', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    dialogs.delete(ctx.from!.id);
    await ctx.reply('Ввод отменён. Сохранённые местоположение и планы не изменены.', { reply_markup: keyboard() });
  });

  const startMode = async (ctx: Context, mode: Mode) => {
    if (ctx.chat?.type !== 'private') return;
    await safely(ctx, mode, async () => {
      if (!await authorized(ctx)) return;
      if (mode === 'destination') {
        if (!await service.hasLocation(String(ctx.from!.id))) throw new LocationError('no_location');
        await askDestination(ctx);
      } else {
        begin(ctx.from!.id, mode);
        await ctx.reply(mode === 'find'
          ? '🔎 Где искать путешественников? Напишите страну, регион или населённый пункт. Например: Россия, Тверская область, Москва Россия.\n/cancel — отменить поиск.'
          : '📍 Напишите населённый пункт и страну, например: Нижний Новгород Россия.\n/cancel — отменить ввод.');
      }
    });
  };
  bot.command('find', (ctx) => startMode(ctx, 'find'));
  bot.hears(BUTTONS.find, (ctx) => startMode(ctx, 'find'));
  bot.command('destination', (ctx) => startMode(ctx, 'destination'));
  bot.hears(BUTTONS.destination, (ctx) => startMode(ctx, 'destination'));
  bot.hears(BUTTONS.text, (ctx) => startMode(ctx, 'current'));

  bot.on('message:location', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await safely(ctx, 'location', async () => {
      if (!await authorized(ctx)) return;
      begin(ctx.from.id, 'current');
      await saved(ctx, await service.setLocation(author(ctx), ctx.message.location));
    });
  });

  const list = async (ctx: Context) => {
    await safely(ctx, 'list', async () => {
      if (ctx.chat?.type === 'private' && !await authorized(ctx)) return;
      for (const text of formatListParts(await service.listGroups())) {
        await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
      logger.info({ event: 'list_shown', update_id: ctx.update.update_id });
    });
  };
  bot.command('list', list);
  bot.hears(BUTTONS.list, (ctx) => ctx.chat.type === 'private' ? list(ctx) : Promise.resolve());

  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return;
    await safely(ctx, 'text', async () => {
      if (!await authorized(ctx)) return;
      const mode = dialogs.get(ctx.from.id)?.mode ?? 'current';
      const state = begin(ctx.from.id, mode);
      const candidates = await service.resolveText(ctx.message.text, mode !== 'find');
      if (candidates.length === 1 && candidates[0]!.exact) { await apply(ctx, mode, candidates[0]!); return; }
      state.candidates = candidates;
      const choices = new InlineKeyboard();
      candidates.forEach((candidate, index) => {
        const label = [candidate.type === 'county' ? candidate.county : candidate.city || candidate.region || candidate.country,
          candidate.city || candidate.type === 'county' ? candidate.region : '', candidate.type !== 'country' ? candidate.country : '']
          .filter(Boolean).filter((value, i, values) => values.indexOf(value) === i).join(', ');
        choices.text(label, `place:${state.token}:${index}`).row();
      });
      if (mode === 'destination') choices.text('Пока никуда не планирую', `place:${state.token}:skip`);
      await ctx.reply('Уточните место — выберите подходящий вариант. Можно также прислать более точное название.', { reply_markup: choices });
    });
  });

  bot.on('callback_query', async (ctx) => {
    const match = /^place:([a-f0-9]{12}):(skip|\d+)$/.exec(ctx.callbackQuery.data ?? '');
    if (!match || ctx.chat?.type !== 'private') { await ctx.answerCallbackQuery(); return; }
    const state = dialogs.get(ctx.from.id);
    const candidate = match[2] === 'skip' ? undefined : state?.candidates?.[Number(match[2])];
    if (!state || state.token !== match[1] || (match[2] === 'skip' ? state.mode !== 'destination' : !candidate)) {
      await ctx.answerCallbackQuery({ text: 'Этот выбор уже неактуален. Отправьте место заново или используйте /destination или /find.' });
      return;
    }
    await ctx.answerCallbackQuery();
    await safely(ctx, 'selection', async () => {
      if (!await authorized(ctx)) return;
      // Consume before writing, including an indeterminate storage outcome.
      begin(ctx.from.id, state.mode);
      if (match[2] === 'skip') {
        await service.setDestination(String(ctx.from.id), null);
        dialogs.delete(ctx.from.id);
        await ctx.reply('Планы очищены. Пока никуда не планируете.', { reply_markup: keyboard() });
      } else await apply(ctx, state.mode, candidate!);
    });
  });
}
