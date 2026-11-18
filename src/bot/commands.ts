import { randomBytes } from 'node:crypto';
import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { Coordinates, CurrentUser, PlaceCandidate, TelegramUser } from '../domain/models.js';
import { locationLabel } from '../domain/geocoder.js';
import type { LocationService } from '../services/location-service.js';
import type { PinnedMessageService } from '../services/pinned-message-service.js';
import { formatChoices, formatHome, formatListPages, formatListParts, formatPlans, formatPurpose, formatSaved, formatSearch } from './formatting.js';
import { BUTTONS, errorText, HELP_TEXT, MAP_HELP, MAP_INTRO, modeHint, TEXT } from './messages.js';
import type { InputMode } from './messages.js';
import { choicesKeyboard, geoKeyboard, groupKeyboard, homeButton, mainKeyboard, miniAppLink, nearbyKeyboard, pageKeyboard, plansKeyboard, purposeKeyboard } from './keyboards.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';
import { registerGroupCommands } from './setup.js';
import { isGroupMember } from './membership.js';

export { errorText } from './messages.js';

interface Dialog {
  mode: InputMode | 'home' | 'purpose' | 'plans' | 'geo';
  token: string;
  draft?: string;
  candidates?: PlaceCandidate[];
  pages?: string[];
  page?: number;
  messageId?: number;
  coordinates?: Coordinates;
  previous?: Dialog;
}

export function registerCommands(bot: Bot, service: LocationService, groupId: string, logger: AppLogger = silentLogger, pinned?: Pick<PinnedMessageService, 'update'>, mapShortName?: string): void {
  const dialogs = new Map<number, Dialog>();
  const queues = new Map<number, Promise<void>>();
  const keyboards = new Map<number, string>();
  const logFailure = (ctx: Context, action: string, error: unknown) => logger.error({ event: 'command_failed', action, update_id: ctx.update.update_id, ...safeError(error) });
  const stateOf = (ctx: Context) => ctx.from ? dialogs.get(ctx.from.id) : undefined;
  const member = async (ctx: Context): Promise<boolean> => {
    if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat) return false;
    return isGroupMember(ctx.api, groupId, ctx.from.id);
  };
  const ignoreUnmodified = (error: unknown) => error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('message is not modified');
  const clearButtons = async (ctx: Context, state = stateOf(ctx)) => {
    if (!state?.messageId || !ctx.chat) return;
    try { await ctx.api.editMessageReplyMarkup(ctx.chat.id, state.messageId, { reply_markup: { inline_keyboard: [] } }); }
    catch (error) { if (!ignoreUnmodified(error)) logFailure(ctx, 'clear_buttons', error); }
    state.messageId = undefined;
  };
  const begin = async (ctx: Context, mode: Dialog['mode']): Promise<Dialog> => {
    await clearButtons(ctx);
    const state: Dialog = { mode, token: randomBytes(6).toString('hex') };
    dialogs.set(ctx.from!.id, state);
    return state;
  };
  const keyboardMode = (ctx: Context) => {
    const state = stateOf(ctx);
    const mode = state?.mode === 'geo' ? state.previous?.mode : state?.mode;
    return mode === 'current' ? 'current' : 'main';
  };
  const emit = async (ctx: Context, text: string, inline?: InlineKeyboard, edit = false) => {
    const variant = keyboardMode(ctx);
    const options = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
    // A draft already contains the place. Inline clarification can reuse the
    // installed navigation instead of adding a message just to change it.
    if (edit && ctx.callbackQuery?.message && (keyboards.get(ctx.chat!.id) === variant || (inline && keyboards.has(ctx.chat!.id)))) {
      try {
        await ctx.editMessageText(text, { ...options, reply_markup: inline ?? new InlineKeyboard() });
      } catch (error) { if (!ignoreUnmodified(error)) throw error; }
      const state = stateOf(ctx);
      if (state && inline) state.messageId = ctx.callbackQuery.message.message_id;
      return;
    }
    // Telegram accepts only one keyboard type per message. On a direct first
    // visit to an inline screen, install navigation using a useful home card.
    if (inline && keyboards.get(ctx.chat!.id) !== variant) {
      await ctx.reply(formatHome(await service.getUser(String(ctx.from!.id))), {
        ...options, reply_markup: mainKeyboard(variant === 'current', !!mapShortName),
      });
      keyboards.set(ctx.chat!.id, variant);
    }
    const message = await ctx.reply(text, { ...options,
      reply_markup: inline ?? mainKeyboard(variant === 'current', !!mapShortName),
    });
    if (!inline) keyboards.set(ctx.chat!.id, variant);
    else { const state = stateOf(ctx); if (state) state.messageId = message.message_id; }
  };
  const authorized = async (ctx: Context) => {
    if (await member(ctx)) return true;
    await begin(ctx, 'home');
    await emit(ctx, TEXT.denied);
    return false;
  };
  const safely = async (ctx: Context, action: string, operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) {
      logFailure(ctx, action, error);
      const state = stateOf(ctx);
      const hint = modeHint(state?.mode);
      await emit(ctx, `${errorText(error, action)}${hint ? `\n\n${hint}` : ''}`);
    }
  };
  const author = (ctx: Context): TelegramUser => ({ user_id: String(ctx.from!.id),
    display_name: [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' '), username: ctx.from!.username ?? null });
  const home = async (ctx: Context) => {
    await begin(ctx, 'home');
    await emit(ctx, formatHome(await service.getUser(String(ctx.from!.id))), undefined, true);
  };
  const saved = async (ctx: Context, user: CurrentUser) => {
    await begin(ctx, 'home');
    logger.info({ event: 'location_saved', update_id: ctx.update.update_id });
    // Confirmation means the record was saved, not that the group pin succeeded.
    try { await pinned?.update(); } catch (error) { logFailure(ctx, 'pin', error); }
    await emit(ctx, formatSaved(locationLabel(user)), undefined, true);
  };
  const showPages = async (ctx: Context, pages: string[], mode: 'home' | 'find') => {
    const state = await begin(ctx, mode);
    state.pages = pages;
    state.page = 0;
    await emit(ctx, pages[0]!, pageKeyboard(state.token, 0, pages.length), true);
  };
  const apply = async (ctx: Context, mode: InputMode, candidate: PlaceCandidate) => {
    // Consume the selection before writes, including indeterminate outcomes.
    await begin(ctx, mode);
    if (mode === 'current') {
      await safely(ctx, 'save', async () => saved(ctx, await service.setTextLocation(author(ctx), candidate)));
    } else if (mode === 'destination') {
      await safely(ctx, 'save', async () => {
        await service.setDestination(String(ctx.from!.id), candidate);
        await begin(ctx, 'home');
        logger.info({ event: 'destination_saved', update_id: ctx.update.update_id });
        await emit(ctx, formatSaved(locationLabel(candidate), true), undefined, true);
      });
    } else {
      await showPages(ctx, formatSearch(locationLabel(candidate), await service.findTravelers(candidate)), 'find');
    }
  };
  const showCandidates = async (ctx: Context, state: Dialog) => {
    const candidates = state.candidates!;
    await emit(ctx, formatChoices(state.mode as InputMode, candidates.length), choicesKeyboard(state.token, candidates), true);
  };
  const resolve = async (ctx: Context, query: string, mode: InputMode) => {
    const state = await begin(ctx, mode);
    const candidates = await service.resolveText(query);
    if (candidates.length === 1 && candidates[0]!.exact) { await apply(ctx, mode, candidates[0]!); return; }
    state.candidates = candidates;
    await showCandidates(ctx, state);
  };
  const input = async (ctx: Context, mode: InputMode, draft?: string, editing = false) => {
    const state = await begin(ctx, mode);
    if (mode === 'destination' && !await service.hasLocation(String(ctx.from!.id))) {
      await begin(ctx, 'home');
      await emit(ctx, TEXT.noLocation);
      return;
    }
    if (draft) { await resolve(ctx, draft, mode); return; }
    const prompt = mode === 'destination' && editing ? TEXT.editDestination : TEXT[mode];
    if (mode === 'find' && await service.hasLocation(String(ctx.from!.id))) {
      await emit(ctx, prompt, nearbyKeyboard(state.token), true);
    } else await emit(ctx, prompt, mode === 'current' ? undefined : homeButton(new InlineKeyboard(), state.token), true);
  };
  const plans = async (ctx: Context) => {
    const state = await begin(ctx, 'plans');
    const user = await service.getUser(String(ctx.from!.id));
    if (!user) { await begin(ctx, 'home'); await emit(ctx, TEXT.noLocation); return; }
    if (!user.destination) { await input(ctx, 'destination'); return; }
    await emit(ctx, formatPlans(user.destination), plansKeyboard(state.token), true);
  };

  bot.use(async (ctx, next) => {
    if (!ctx.chat || !(ctx.chat.type === 'private' || (['group', 'supergroup'].includes(ctx.chat.type) && String(ctx.chat.id) === groupId))) {
      logger.warn({ event: 'telegram_access_denied', update_id: ctx.update.update_id, reason: 'unauthorized_chat' });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
    }
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
  const privateAction = async (ctx: Context, action: string, operation: () => Promise<void>) => {
    if (ctx.chat?.type !== 'private') return;
    await safely(ctx, action, async () => { if (await authorized(ctx)) await operation(); });
  };
  bot.command('start', (ctx) => privateAction(ctx, 'start', () => ctx.match === 'checkin' ? input(ctx, 'current') : home(ctx)));
  bot.command('cancel', (ctx) => privateAction(ctx, 'cancel', () => home(ctx)));
  bot.command('help', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await safely(ctx, 'help', async () => {
      const hint = modeHint(stateOf(ctx)?.mode);
      await emit(ctx, `${HELP_TEXT}${mapShortName ? `\n\n${MAP_HELP}` : ''}${hint ? `\n\n${hint}` : ''}`);
      logger.info({ event: 'help_shown', update_id: ctx.update.update_id });
    });
  });
  bot.command('checkin', (ctx) => privateAction(ctx, 'current', () => input(ctx, 'current')));
  bot.command('find', (ctx) => privateAction(ctx, 'find', () => input(ctx, 'find')));
  bot.command('destination', (ctx) => privateAction(ctx, 'destination', () => plans(ctx)));
  bot.hears([BUTTONS.checkin, '📍 Указать место текстом'], (ctx) => privateAction(ctx, 'current', () => input(ctx, 'current')));
  bot.hears([BUTTONS.find, '🔎 Найти путешественников'], (ctx) => privateAction(ctx, 'find', () => input(ctx, 'find')));
  bot.hears([BUTTONS.destination, '✈️ Изменить планы'], (ctx) => privateAction(ctx, 'destination', () => plans(ctx)));
  bot.hears(BUTTONS.home, (ctx) => privateAction(ctx, 'home', () => home(ctx)));
  if (mapShortName) {
    bot.hears(BUTTONS.map, (ctx) => privateAction(ctx, 'map', async () => {
      await begin(ctx, 'home');
      await emit(ctx, MAP_INTRO, new InlineKeyboard().url('Открыть карту', miniAppLink(ctx.me.username, mapShortName)));
    }));
  }
  const list = async (ctx: Context) => {
    await safely(ctx, 'list', async () => {
      if (ctx.chat?.type === 'private') {
        if (!await authorized(ctx)) return;
        await begin(ctx, 'home');
        await showPages(ctx, formatListPages(await service.listGroups()), 'home');
      } else {
        for (const text of formatListParts(await service.listGroups())) {
          await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: groupKeyboard(ctx.me.username, mapShortName) });
        }
      }
      logger.info({ event: 'list_shown', update_id: ctx.update.update_id });
    });
  };
  bot.command('list', list);
  bot.hears([BUTTONS.list, '🌍 Список путешественников'], (ctx) => ctx.chat.type === 'private' ? list(ctx) : Promise.resolve());
  bot.on('message:location', (ctx) => privateAction(ctx, 'location', async () => {
    const previous = stateOf(ctx);
    if (previous && ['find', 'destination', 'plans', 'geo'].includes(previous.mode)) {
      const state = await begin(ctx, 'geo');
      state.coordinates = ctx.message.location;
      state.previous = previous.mode === 'geo' ? previous.previous : previous;
      await emit(ctx, TEXT.geoConfirm, geoKeyboard(state.token, state.previous?.mode));
    } else {
      await begin(ctx, 'current');
      await saved(ctx, await service.setLocation(author(ctx), ctx.message.location));
    }
  }));
  bot.on('message:text', (ctx) => privateAction(ctx, 'text', async () => {
    if (ctx.message.text.startsWith('/')) { await emit(ctx, TEXT.unknown); return; }
    const state = stateOf(ctx);
    if (state && ['current', 'destination', 'find'].includes(state.mode)) {
      await resolve(ctx, ctx.message.text, state.mode as InputMode);
    } else {
      const next = await begin(ctx, 'purpose');
      // Do not echo arbitrary long text or call the provider before intent is known.
      if (ctx.message.text.trim().length < 2 || ctx.message.text.length > 200) { await emit(ctx, TEXT.input); return; }
      next.draft = ctx.message.text;
      await emit(ctx, formatPurpose(next.draft), purposeKeyboard(next.token));
    }
  }));
  bot.on('callback_query', async (ctx) => {
    const match = /^ui:([a-f0-9]{12}):(home|edit|delete|nearby|current|destination|find|confirm|resume|select:\d+|page:\d+)$/.exec(ctx.callbackQuery.data ?? '');
    const state = stateOf(ctx);
    const message = ctx.callbackQuery.message;
    if (!match || ctx.chat?.type !== 'private' || !state || state.token !== match[1] || !message || message.message_id !== state.messageId) {
      await ctx.answerCallbackQuery({ text: TEXT.stale });
      return;
    }
    await ctx.answerCallbackQuery();
    await safely(ctx, 'selection', async () => {
      if (!await authorized(ctx)) return;
      const action = match[2]!;
      if (action === 'home') { await home(ctx); return; }
      if (action.startsWith('page:') && state.pages) {
        const page = Number(action.slice(5));
        if (Number.isSafeInteger(page) && state.pages[page]) {
          state.page = page;
          await emit(ctx, state.pages[page], pageKeyboard(state.token, page, state.pages.length), true);
        }
      } else if (action.startsWith('select:') && state.candidates && ['current', 'destination', 'find'].includes(state.mode)) {
        const candidate = state.candidates[Number(action.slice(7))];
        if (candidate) await apply(ctx, state.mode as InputMode, candidate);
      } else if (state.mode === 'purpose' && state.draft && ['current', 'destination', 'find'].includes(action)) {
        await input(ctx, action as InputMode, state.draft);
      } else if (action === 'edit' && state.mode === 'plans') {
        await input(ctx, 'destination', undefined, true);
      } else if (action === 'delete' && state.mode === 'plans') {
        await begin(ctx, 'plans');
        await safely(ctx, 'delete', async () => {
          await service.setDestination(String(ctx.from.id), null);
          await begin(ctx, 'home');
          logger.info({ event: 'destination_deleted', update_id: ctx.update.update_id });
          await emit(ctx, TEXT.deleted, undefined, true);
        });
      } else if (action === 'nearby' && state.mode === 'find') {
        const user = await service.getUser(String(ctx.from.id));
        if (!user) { await input(ctx, 'find'); return; }
        const candidate: PlaceCandidate = { ...user, type: user.city ? 'city' : user.county ? 'county' : user.region ? 'state' : 'country', confidence: 1, exact: true };
        await apply(ctx, 'find', candidate);
      } else if (action === 'confirm' && state.mode === 'geo' && state.coordinates) {
        await begin(ctx, 'current');
        await safely(ctx, 'location', async () => saved(ctx, await service.setLocation(author(ctx), state.coordinates!)));
      } else if (action === 'resume' && state.mode === 'geo') {
        const previous = state.previous;
        if (previous?.mode === 'plans') await plans(ctx);
        else if (previous && ['find', 'destination'].includes(previous.mode)) {
          const restored = await begin(ctx, previous.mode);
          restored.candidates = previous.candidates;
          restored.pages = previous.pages;
          restored.page = previous.page;
          if (restored.candidates) await showCandidates(ctx, restored);
          else if (restored.pages) await emit(ctx, restored.pages[restored.page ?? 0]!, pageKeyboard(restored.token, restored.page ?? 0, restored.pages.length), true);
          else await input(ctx, previous.mode as InputMode);
        }
        else await home(ctx);
      }
    });
  });
}
