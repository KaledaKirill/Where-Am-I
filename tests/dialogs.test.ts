import { describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import { registerCommands } from '../src/bot/commands.js';
import { GeoapifyGeocoder } from '../src/adapters/geoapify-geocoder.js';
import { BUTTONS, formatListParts } from '../src/bot/formatting.js';
import { botFixture, locationUpdate, messageUpdate } from './bot-fixture.js';
import { candidate, current, env } from './fixtures.js';

function setup() {
  const f = botFixture();
  f.geocoder.search.mockResolvedValue([candidate]);
  registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID, undefined, f.pinned);
  return f;
}

function button(f: ReturnType<typeof setup>, row = 0): string {
  return (f.calls.at(-1)!.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[row]![0]!.callback_data;
}

function selection(data: string, userId = 1001): Update {
  return { update_id: 2, callback_query: {
    id: 'selection', chat_instance: 'instance', data, from: { id: userId, is_bot: false, first_name: 'Анна' },
    message: { message_id: 100, date: 1, chat: { id: userId, type: 'private', first_name: 'Анна' },
      from: { id: 123456789, is_bot: true, first_name: 'Bot' } },
  } };
}

describe('private dialogs', () => {
  it('keeps destination mode after a rejected typo and stores the corrected place only as a destination', async () => {
    const f = setup();
    await f.bot.handleUpdate(locationUpdate());
    const before = structuredClone(f.repo.users.get('1001'));
    const pin = vi.spyOn(f.pinned, 'update');
    f.geocoder.search.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...candidate, city: 'Москва', region: 'Москва', country: 'Россия', country_code: 'ru' }]);
    await f.bot.handleUpdate(messageUpdate('Моск Россия', 1001));
    expect(f.calls.at(-1)?.payload.text).toContain('Продолжаем ввод пункта назначения');
    await f.bot.handleUpdate(messageUpdate('Москва Россия', 1001));
    expect(f.repo.users.get('1001')).toMatchObject({ ...before, destination: { city: 'Москва', country: 'Россия' } });
    expect(f.calls.at(-1)?.payload.text).toContain('✈️ Планы сохранены: Москва, Россия');
    expect(f.repo.history).toHaveLength(1);
    expect(pin).not.toHaveBeenCalled();
  });

  it('requires city and country in destination entry using the same actual adapter validation as current marks', async () => {
    const f = setup();
    await f.bot.handleUpdate(locationUpdate());
    const result = { city: 'Москва', state: 'Москва', country: 'Россия', country_code: 'ru', result_type: 'city', lat: 55.75, lon: 37.61,
      rank: { confidence: 1, match_type: 'full_match' } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ results: [result], query: { parsed: { country: 'Россия' } } })));
    const geocoder = new GeoapifyGeocoder('test-key', fetcher);
    f.geocoder.search.mockImplementation((query: string, settlementsOnly: boolean) => geocoder.search(query, settlementsOnly));
    for (const text of ['Москва', 'Россия']) {
      await f.bot.handleUpdate(messageUpdate(text, 1001));
      expect(f.repo.users.get('1001')?.destination).toBeNull();
      expect(f.calls.at(-1)?.payload.text).toContain('Продолжаем ввод пункта назначения');
      expect(f.geocoder.search).toHaveBeenLastCalledWith(text, true);
    }
    await f.bot.handleUpdate(messageUpdate('Москва Россия', 1001));
    expect(f.repo.users.get('1001')?.destination).toMatchObject({ city: 'Москва', country_code: 'ru' });
    expect(f.repo.history).toHaveLength(1);
  });

  it.each(['current', 'destination', 'find'] as const)('retains %s mode through malformed input, missing places and provider errors', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate(mode === 'current' ? BUTTONS.text : mode === 'find' ? '/find' : '/destination', 1001));
    const before = structuredClone(f.repo.users.get('1001'));
    await f.bot.handleUpdate(messageUpdate('???', 1001));
    expect(f.geocoder.search).not.toHaveBeenCalled();
    f.geocoder.search.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('provider offline')).mockResolvedValue([candidate]);
    for (const text of ['НетТакогоМеста Россия', 'Берлн Германия']) {
      await f.bot.handleUpdate(messageUpdate(text, 1001));
      expect(f.geocoder.search).toHaveBeenLastCalledWith(text, mode !== 'find');
      expect(f.repo.users.get('1001')).toEqual(before);
      expect(f.repo.history).toHaveLength(0);
      expect(String(f.calls.at(-1)?.payload.text)).toContain(mode === 'destination' ? 'ввод пункта назначения' : mode === 'find' ? 'поиск путешественников' : 'отметку текущего местоположения');
    }
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин Германия', mode !== 'find');
    expect(f.repo.history).toHaveLength(mode === 'current' ? 1 : 0);
    expect(f.calls.at(-1)?.payload.text).toContain(mode === 'destination' ? 'Планы сохранены' : mode === 'find' ? 'Сейчас находятся здесь' : 'Куда направляешься');
  });

  it.each(['destination', 'find'] as const)('keeps %s mode after a failed replacement geolocation', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate(mode === 'find' ? '/find' : '/destination', 1001));
    f.geocoder.reverse.mockRejectedValueOnce(new Error('provider offline'));
    await f.bot.handleUpdate(locationUpdate());
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин Германия', mode !== 'find');
    expect(f.repo.history).toHaveLength(0);
    expect(f.calls.at(-1)?.payload.text).toContain(mode === 'destination' ? 'Планы сохранены' : 'Сейчас находятся здесь');
  });

  it.each(['current', 'destination', 'find'] as const)('keeps %s mode when storage fails and retries the same operation after new input', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', current);
    await f.bot.handleUpdate(messageUpdate(mode === 'current' ? BUTTONS.text : mode === 'find' ? '/find' : '/destination', 1001));
    const operation = vi.spyOn(f.repo, mode === 'current' ? 'saveLocation' : mode === 'find' ? 'listUsers' : 'saveDestination');
    operation.mockRejectedValueOnce(new Error('storage offline'));
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин Германия', mode !== 'find');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(f.repo.history).toHaveLength(mode === 'current' ? 1 : 0);
  });

  it('keeps destination mode after failed clearing and consumes the old button without changing the current mark', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const skip = button(f);
    const save = vi.spyOn(f.repo, 'saveDestination').mockRejectedValueOnce(new Error('storage offline'));
    await f.bot.handleUpdate(selection(skip));
    await f.bot.handleUpdate(selection(skip));
    expect(save).toHaveBeenCalledTimes(1);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.repo.history).toHaveLength(0);
  });

  it('always installs a persistent main keyboard, including before the first inline prompt and after errors', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const first = f.calls.filter((call) => call.method === 'sendMessage');
    expect(first[0]?.payload.reply_markup).toMatchObject({ is_persistent: true, one_time_keyboard: false });
    expect(first[1]?.payload.reply_markup).toHaveProperty('inline_keyboard');
    await f.bot.handleUpdate(messageUpdate('???', 1001));
    await f.bot.handleUpdate(messageUpdate('/cancel', 1001));
    await f.bot.handleUpdate(messageUpdate('/find', 1001));
    await f.bot.handleUpdate(messageUpdate('Берлин', 1001));
    await f.bot.handleUpdate(messageUpdate('/list', 1001));
    for (const call of f.calls.filter((call) => call.method === 'sendMessage')) {
      const markup = call.payload.reply_markup as Record<string, unknown>;
      expect(markup).toBeDefined();
      if (!('inline_keyboard' in markup)) expect(markup).toMatchObject({ is_persistent: true, one_time_keyboard: false });
      expect(markup).not.toHaveProperty('remove_keyboard');
    }
    expect([...f.repo.settings.keys()].some((key) => key.startsWith('dialog'))).toBe(false);
  });

  it('keeps consecutive city names in find mode after populated and empty results, until canceled', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, country_code: 'de' });
    await f.bot.handleUpdate(messageUpdate('/find', 1001));
    await f.bot.handleUpdate(messageUpdate('Берлин', 1001));
    f.geocoder.search.mockResolvedValue([{ ...candidate, city: 'Минск', region: '', country: 'Беларусь', country_code: 'by' }]);
    await f.bot.handleUpdate(messageUpdate('минск', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('минск', false);
    expect(f.calls.at(-1)?.payload.text).toContain('Пока никого нет');
    f.geocoder.search.mockResolvedValue([{ ...candidate, city: 'Гомель', region: 'Гомельская область', country: 'Беларусь', country_code: 'by' }]);
    await f.bot.handleUpdate(messageUpdate('гомель', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('гомель', false);
    expect(f.calls.at(-1)?.payload.text).toContain('🔎 Гомель, Беларусь');
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(messageUpdate('/cancel', 1001));
    await f.bot.handleUpdate(messageUpdate('Гомель Беларусь', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Гомель Беларусь', true);
    expect(f.repo.history).toHaveLength(1);
  });

  it('saves exact text marks, asks about plans, changes them independently and clears them without history or pin updates', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин Германия', true);
    expect(f.repo.history).toHaveLength(1);
    expect(f.repo.history[0]).toMatchObject({ coordinate_source: 'geocoded', country_code: 'de' });
    expect(f.calls.at(-1)?.payload.text).toContain('✈️ Куда направляешься?');
    const pin = vi.spyOn(f.pinned, 'update');
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.repo.users.get('1001')?.destination?.city).toBe('Берлин');
    await f.bot.handleUpdate(messageUpdate(BUTTONS.destination, 1001));
    await f.bot.handleUpdate(selection(button(f)));
    expect(f.repo.users.get('1001')?.destination).toBeNull();
    expect(f.repo.history).toHaveLength(1);
    expect(pin).not.toHaveBeenCalled();
  });

  it('does not save ambiguous or corrected candidates until the matching user selects one, then consumes duplicate clicks', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }, { ...candidate, city: 'Другой Берлин', region: 'Другой регион', exact: false }]);
    await f.bot.handleUpdate(messageUpdate('Берлн Германия', 1001));
    const choose = button(f);
    expect(Buffer.byteLength(choose)).toBeLessThanOrEqual(64);
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(selection(choose, 1002));
    expect(f.repo.history).toHaveLength(0);
    await Promise.all([f.bot.handleUpdate(selection(choose)), f.bot.handleUpdate(selection(choose))]);
    expect(f.repo.history).toHaveLength(1);
    expect(f.calls.at(-1)?.payload.text).toContain('неактуален');
  });

  it('keeps input modes isolated between people and ignores stale selection after replacement text or restart', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await f.bot.handleUpdate(messageUpdate('Берлн Германия', 1001));
    const old = button(f);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    await f.bot.handleUpdate(selection(old));
    expect(f.repo.history).toHaveLength(0);
    const restarted = setup();
    await restarted.bot.handleUpdate(selection(old));
    expect(restarted.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(messageUpdate('/find', 1002, 1002));
    await f.bot.handleUpdate(messageUpdate('Берлин', 1002, 1002));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин', false);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин Германия', true);
  });

  it('replaces destination entry with search without changing plans, and renders both matching categories', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, country_code: 'de', destination: candidate });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const oldSkip = button(f);
    await f.bot.handleUpdate(messageUpdate('/find', 1001));
    await f.bot.handleUpdate(messageUpdate('Берлин', 1001));
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин', false);
    expect(f.calls.at(-1)?.payload.text).toContain('📍 Сейчас находятся здесь');
    expect(f.calls.at(-1)?.payload.text).toContain('✈️ Планируют сюда приехать');
    expect(String(f.calls.at(-1)?.payload.text).match(/https:\/\/t.me\/anna/g)).toHaveLength(2);
    await f.bot.handleUpdate(selection(oldSkip));
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    expect(f.repo.history).toHaveLength(0);
  });

  it('uses selection for ambiguous searches and handles empty search results without writes', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await f.bot.handleUpdate(messageUpdate('/find', 1001));
    await f.bot.handleUpdate(messageUpdate('Берлин', 1001));
    await f.bot.handleUpdate(selection(button(f)));
    expect(f.calls.at(-1)?.payload.text).toContain('Пока никого нет');
    expect(f.repo.users.size).toBe(0);
    expect(f.repo.history).toHaveLength(0);
  });

  it('makes a new Telegram location supersede pending plans and retains old plans until an explicit change', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const old = button(f);
    await f.bot.handleUpdate(locationUpdate());
    expect(f.repo.history).toHaveLength(1);
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    const currentSkip = button(f);
    await f.bot.handleUpdate(selection(old));
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    await f.bot.handleUpdate(selection(currentSkip));
    expect(f.repo.users.get('1001')?.destination).toBeNull();
  });

  it.each(['/cancel', '/start', BUTTONS.text])('replaces a pending destination with current mode using %s', async (command) => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const old = button(f);
    await f.bot.handleUpdate(messageUpdate(command, 1001));
    await f.bot.handleUpdate(selection(old));
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.repo.history).toHaveLength(1);
  });

  it('preserves pending destination through help and list and excludes plans from list and pin', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: { ...candidate, city: 'Секретный пункт' } });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    const skip = button(f);
    await f.bot.handleUpdate(messageUpdate('/help', 1001));
    await f.bot.handleUpdate(messageUpdate('/list', 1001));
    const parts = formatListParts(await f.service.listGroups());
    expect(f.calls.at(-1)?.payload.text).toBe(parts[0]);
    expect(parts.join('')).not.toContain('Секретный пункт');
    await f.pinned.update();
    expect(f.calls.filter((call) => call.method === 'sendMessage' && call.payload.chat_id === env.TELEGRAM_GROUP_ID).map((call) => call.payload.text)).toEqual(parts);
    await f.bot.handleUpdate(selection(skip));
    expect(f.repo.users.get('1001')?.destination).toBeNull();
  });

  it('retains destination entry after invalid input, missing places and provider failure, with a working skip button', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    await f.bot.handleUpdate(messageUpdate('???', 1001));
    expect(f.geocoder.search).not.toHaveBeenCalled();
    f.geocoder.search.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('secret-key'));
    await f.bot.handleUpdate(messageUpdate('НетТакогоМеста Россия', 1001));
    expect(f.calls.at(-1)?.payload.text).toContain('Место не найдено');
    await f.bot.handleUpdate(messageUpdate('Берлин Германия', 1001));
    expect(f.calls.at(-1)?.payload.text).toContain('Не удалось определить');
    await f.bot.handleUpdate(selection(button(f)));
    expect(f.repo.users.get('1001')?.destination).toBeNull();
    expect(f.repo.history).toHaveLength(0);
  });

  it('requires membership for search, text entry and callbacks, including after leaving during selection', async () => {
    const f = setup();
    for (const text of ['/find', 'Берлин Германия']) {
      f.transport.mockResolvedValueOnce({ ok: true, result: { status: 'left' } });
      await f.bot.handleUpdate(messageUpdate(text, 1001));
    }
    expect(f.geocoder.search).not.toHaveBeenCalled();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await f.bot.handleUpdate(messageUpdate('Берлн Германия', 1001));
    const choose = button(f);
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (...args) => args[1] === 'getChatMember' ? { ok: true, result: { status: 'left' } } : original(...args));
    await f.bot.handleUpdate(selection(choose));
    expect(f.repo.history).toHaveLength(0);
  });

  it('requires a current mark before editing plans, and offers no new commands in groups', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('/destination', 1001));
    expect(f.calls.at(-1)?.payload.text).toContain('Сначала отметьте');
    f.calls.length = 0;
    for (const text of ['/find', '/destination', '/cancel', BUTTONS.find, BUTTONS.destination, BUTTONS.text]) await f.bot.handleUpdate(messageUpdate(text));
    expect(f.calls).toHaveLength(0);
  });

  it('invalidates an attempted selection after storage failure without blindly repeating the write', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await f.bot.handleUpdate(messageUpdate('Берлн Германия', 1001));
    const choose = button(f);
    const save = vi.spyOn(f.repo, 'saveLocation').mockRejectedValue(new Error('network'));
    await f.bot.handleUpdate(selection(choose));
    await f.bot.handleUpdate(selection(choose));
    expect(save).toHaveBeenCalledTimes(1);
    expect(f.repo.history).toHaveLength(0);
  });
});
