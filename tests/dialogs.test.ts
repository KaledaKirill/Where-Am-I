import { describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import { registerCommands } from '../src/bot/commands.js';
import { GeoapifyGeocoder } from '../src/adapters/geoapify-geocoder.js';
import { BUTTONS, TEXT } from '../src/bot/messages.js';
import { checkListLength } from '../src/bot/formatting.js';
import { botFixture, locationUpdate, messageUpdate } from './bot-fixture.js';
import { candidate, current, env } from './fixtures.js';

function setup() {
  const f = botFixture();
  f.geocoder.search.mockResolvedValue([candidate]);
  registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID, undefined, f.pinned);
  return f;
}
type Fixture = ReturnType<typeof setup>;
function button(f: Fixture, action: string, userId = 1001) {
  for (const call of [...f.calls].reverse()) {
    if (!['sendMessage', 'editMessageText'].includes(call.method) || call.payload.chat_id !== userId) continue;
    const markup = call.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
    const found = markup?.inline_keyboard?.flat().find((item) => item.callback_data?.endsWith(`:${action}`));
    if (found) return { data: found.callback_data!, messageId: call.messageId!, userId };
  }
  throw new Error(`Missing button ${action}`);
}
function selection(target: ReturnType<typeof button>, userId = target.userId): Update {
  return { update_id: 2, callback_query: {
    id: 'selection', chat_instance: 'instance', data: target.data, from: { id: userId, is_bot: false, first_name: 'Анна' },
    message: { message_id: target.messageId, date: 1, chat: { id: target.userId, type: 'private', first_name: 'Анна' },
      from: { id: 123456789, is_bot: true, first_name: 'Bot' } },
  } };
}
const click = (f: Fixture, action: string) => f.bot.handleUpdate(selection(button(f, action)));
const text = (f: Fixture) => String([...f.calls].reverse().find((call) => ['sendMessage', 'editMessageText'].includes(call.method))?.payload.text);
const say = (f: Fixture, value: string, id = 1001) => f.bot.handleUpdate(messageUpdate(value, id, id));

describe('explicit private dialogs', () => {
  it.each(['current', 'destination', 'find'])('asks intent before resolving an idle message and routes it to %s', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, 'Берлин');
    expect(text(f)).toBe('<b>Что сделать с этим местом?</b>\n\nБерлин');
    expect(f.geocoder.search).not.toHaveBeenCalled();
    expect(f.repo.history).toHaveLength(0);
    await click(f, mode);
    expect(f.geocoder.search).toHaveBeenLastCalledWith('Берлин', false);
    expect(f.repo.history).toHaveLength(mode === 'current' ? 1 : 0);
    expect(f.repo.users.get('1001')?.destination?.city ?? null).toBe(mode === 'destination' ? 'Берлин' : null);
    expect(text(f)).toContain(mode === 'find' ? 'Отметились здесь' : mode === 'destination' ? 'Планы сохранены' : 'Место сохранено');
  });

  it('finishes check-in with one confirmation and leaves existing plans unchanged', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await say(f, '/checkin');
    await say(f, 'Берлин');
    expect(f.repo.history).toHaveLength(1);
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    const confirmations = f.calls.filter((call) => call.payload.chat_id === 1001 && String(call.payload.text).includes('Место сохранено'));
    expect(confirmations).toHaveLength(1);
    expect(text(f)).not.toContain('Куда');
    expect(f.calls.at(-1)?.payload.reply_markup).toMatchObject({ keyboard: [[{ text: BUTTONS.checkin }, { text: BUTTONS.destination }], [{ text: BUTTONS.find }, { text: BUTTONS.list }]] });
    await say(f, 'Минск');
    expect(text(f)).toContain('Что сделать');
    expect(f.repo.history).toHaveLength(1);
  });

  it('opens search and plans from an existing menu without repeating the home card', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, '/start');
    const count = () => f.calls.filter((call) => call.method === 'sendMessage').length;
    const before = count();
    await say(f, '/find');
    expect(count()).toBe(before + 1);
    expect(text(f)).toBe(TEXT.find);
    await say(f, '/destination');
    expect(count()).toBe(before + 2);
    expect(text(f)).toBe(TEXT.destination);
  });

  it('shows and independently edits or explicitly deletes saved plans', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    const before = structuredClone(f.repo.users.get('1001'));
    await say(f, '/destination');
    expect(text(f)).toContain('Направление: Берлин, Германия');
    expect(f.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2);
    await click(f, 'edit');
    expect(text(f)).toContain('Сохранённые планы изменятся');
    f.geocoder.search.mockResolvedValue([{ ...candidate, type: 'country', city: '', region: '', country: 'Грузия', country_code: 'ge' }]);
    await say(f, 'Грузия');
    expect(f.repo.users.get('1001')).toMatchObject({ ...before, destination: { city: '', country: 'Грузия' } });
    await say(f, '/destination');
    const remove = button(f, 'delete');
    await f.bot.handleUpdate(selection(remove));
    expect(text(f)).toBe(TEXT.deleted);
    await f.bot.handleUpdate(selection(remove));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    expect(f.repo.users.get('1001')?.destination).toBeNull();
    expect(f.repo.history).toHaveLength(0);
    expect(f.calls.some((call) => call.method === 'pinChatMessage')).toBe(false);
  });

  it.each(['/start', '/cancel', '/list', BUTTONS.home])('ends pending input through %s without modifying plans', async (exit) => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await say(f, '/destination');
    const old = button(f, 'delete');
    await click(f, 'edit');
    await say(f, exit);
    await f.bot.handleUpdate(selection(old));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    await say(f, 'Минск');
    expect(text(f)).toContain('Что сделать');
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    expect(f.repo.history).toHaveLength(0);
  });

  it('retains pending destination through help and allows retry after input/provider errors', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, '/destination');
    await say(f, '/help');
    expect(text(f)).toContain('Сейчас ожидаю новое направление поездки.');
    await say(f, '???');
    expect(f.geocoder.search).not.toHaveBeenCalled();
    f.geocoder.search.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('provider offline')).mockResolvedValue([candidate]);
    await say(f, 'НетТакогоМеста');
    expect(text(f)).toContain('Не удалось найти это место');
    await say(f, 'Берлин');
    expect(text(f)).toContain('Сейчас не получается найти место');
    await say(f, 'Берлин');
    expect(f.repo.users.get('1001')?.destination?.city).toBe('Берлин');
    expect(f.repo.history).toHaveLength(0);
  });

  it.each(['current', 'destination', 'find'] as const)('retains %s input after repository failure, without automatic retries', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, mode === 'current' ? '/checkin' : mode === 'find' ? '/find' : '/destination');
    const operation = vi.spyOn(f.repo, mode === 'current' ? 'saveLocation' : mode === 'find' ? 'listUsers' : 'saveDestination');
    operation.mockRejectedValueOnce(new Error('offline'));
    await say(f, 'Берлин');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.repo.history).toHaveLength(0);
    await say(f, 'Берлин');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(f.repo.history).toHaveLength(mode === 'current' ? 1 : 0);
  });

  it('confirms ambiguous and corrected places only for the owning user, message and active token', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await say(f, '/checkin');
    await say(f, 'Берлн');
    const choose = button(f, 'select:0');
    expect(text(f)).toContain('Возможно, ты имеешь в виду');
    await f.bot.handleUpdate(selection(choose, 2002));
    await f.bot.handleUpdate(selection({ ...choose, messageId: choose.messageId - 1 }));
    expect(f.repo.history).toHaveLength(0);
    await Promise.all([f.bot.handleUpdate(selection(choose)), f.bot.handleUpdate(selection(choose))]);
    expect(f.repo.history).toHaveLength(1);
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    expect(f.calls.some((call) => call.method === 'editMessageReplyMarkup' && call.payload.message_id === choose.messageId)).toBe(true);
  });

  it('consumes a selection on uncertain writes and requires fresh input for retry', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await say(f, '/checkin');
    await say(f, 'Берлн');
    const choose = button(f, 'select:0');
    const save = vi.spyOn(f.repo, 'saveLocation').mockRejectedValueOnce(new Error('unknown outcome'));
    await f.bot.handleUpdate(selection(choose));
    expect(text(f)).toContain('Не удалось сохранить изменения');
    await f.bot.handleUpdate(selection(choose));
    expect(save).toHaveBeenCalledTimes(1);
    f.geocoder.search.mockResolvedValue([candidate]);
    await say(f, 'Берлин');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('makes old choices stale on replacement input and loses pending choices after restart', async () => {
    const f = setup();
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await say(f, '/find');
    await say(f, 'Берлн');
    const first = button(f, 'select:0');
    await say(f, 'Берлин');
    await f.bot.handleUpdate(selection(first));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    const restarted = setup();
    await restarted.bot.handleUpdate(selection(button(f, 'select:0')));
    expect(restarted.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    expect(restarted.repo.history).toHaveLength(0);
  });

  it('keeps different users in independent input modes', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, '/destination');
    await say(f, '/find', 2002);
    await say(f, 'Берлин', 2002);
    await say(f, 'Берлин');
    expect(f.repo.users.get('1001')?.destination?.city).toBe('Берлин');
    expect(f.repo.users.has('2002')).toBe(false);
  });

  it('keeps search active across populated and empty results until another section is opened', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, country_code: 'de', destination: candidate });
    await say(f, '/find');
    await say(f, 'Берлин');
    expect(text(f)).toContain('Отметились здесь · 1');
    expect(text(f)).toContain('Планируют приехать · 1');
    expect(text(f).match(/https:\/\/t.me\/anna/g)).toHaveLength(2);
    f.geocoder.search.mockResolvedValue([{ ...candidate, city: 'Минск' }]);
    await say(f, 'Минск');
    expect(text(f)).toContain('Пока нет участников');
    await say(f, '/list');
    await say(f, 'Берлин');
    expect(text(f)).toContain('Что сделать');
    expect(f.repo.history).toHaveLength(0);
  });

  it('searches in the saved place without contacting the geocoder, including legacy rows', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    await say(f, '/find');
    await click(f, 'nearby');
    expect(text(f)).toContain('Отметились здесь · 1');
    expect(f.geocoder.search).not.toHaveBeenCalled();
    expect(f.geocoder.reverse).not.toHaveBeenCalled();
  });

  it('paginates private lists by editing the same message and rejects old page buttons', async () => {
    const f = setup();
    for (let i = 0; i < 23; i++) f.repo.users.set(String(i + 1), { ...current, user_id: String(i + 1), username: null, display_name: `Участник ${String(i).padStart(2, '0')}` });
    await say(f, '/list');
    expect(text(f)).toContain('Страница 1 из 3');
    expect(text(f).match(/tg:\/\/user\?id=/g)).toHaveLength(10);
    const next = button(f, 'page:1');
    const sends = f.calls.filter((call) => call.method === 'sendMessage').length;
    await f.bot.handleUpdate(selection(next));
    expect(text(f)).toContain('Страница 2 из 3');
    expect(f.calls.at(-1)?.method).toBe('editMessageText');
    expect(f.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(sends);
    expect(f.calls.at(-1)?.payload.message_id).toBe(next.messageId);
    await say(f, '/checkin');
    await f.bot.handleUpdate(selection(next));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    f.calls.filter((call) => typeof call.payload.text === 'string').forEach((call) => expect(() => checkListLength(String(call.payload.text))).not.toThrow());
  });

  it.each(['find', 'destination', 'plans'] as const)('requires confirmation for geolocation during %s', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: mode === 'plans' ? candidate : null });
    await say(f, mode === 'find' ? '/find' : '/destination');
    await f.bot.handleUpdate(locationUpdate());
    expect(text(f)).toBe(TEXT.geoConfirm);
    expect(f.geocoder.reverse).not.toHaveBeenCalled();
    expect(f.repo.history).toHaveLength(0);
    const confirm = button(f, 'confirm');
    await click(f, 'resume');
    await f.bot.handleUpdate(selection(confirm));
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(locationUpdate());
    await click(f, 'confirm');
    expect(f.repo.history).toHaveLength(1);
    expect(text(f)).toContain('Место сохранено');
    expect(f.repo.users.get('1001')?.destination).toEqual(mode === 'plans' ? candidate : null);
  });

  it('keeps current input after a confirmed geolocation lookup fails', async () => {
    const f = setup();
    await say(f, '/find');
    await f.bot.handleUpdate(locationUpdate());
    const confirm = button(f, 'confirm');
    f.geocoder.reverse.mockRejectedValueOnce(new Error('offline'));
    await f.bot.handleUpdate(selection(confirm));
    expect(text(f)).toContain('Не удалось определить место по геолокации');
    await f.bot.handleUpdate(selection(confirm));
    expect(f.geocoder.reverse).toHaveBeenCalledTimes(1);
    await say(f, 'Берлин');
    expect(f.repo.history).toHaveLength(1);
  });

  it('invalidates a pending geolocation confirmation on new input or navigation', async () => {
    const f = setup();
    await say(f, '/find');
    await f.bot.handleUpdate(locationUpdate());
    const old = button(f, 'confirm');
    await say(f, 'Минск');
    await f.bot.handleUpdate(selection(old));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    expect(f.repo.history).toHaveLength(0);
  });

  it('returns from geolocation confirmation to the same search page and frozen results', async () => {
    const f = setup();
    for (let i = 0; i < 15; i++) f.repo.users.set(String(i + 1), { ...current, country_code: 'de', user_id: String(i + 1), display_name: `Имя ${String(i).padStart(2, '0')}` });
    await say(f, '/find');
    await say(f, 'Берлин');
    await click(f, 'page:1');
    const before = text(f);
    const oldPage = button(f, 'page:0');
    await f.bot.handleUpdate(locationUpdate());
    f.repo.users.clear();
    await click(f, 'resume');
    expect(text(f)).toBe(before);
    await f.bot.handleUpdate(selection(oldPage));
    expect(f.calls.at(-1)?.payload.text).toBe(TEXT.stale);
    await click(f, 'page:0');
    expect(text(f)).toContain('Отметились здесь · 15');
    expect(f.geocoder.search).toHaveBeenCalledTimes(1);
  });

  it('restores pending place choices after declining a geolocation update', async () => {
    const f = setup();
    f.repo.users.set('1001', current);
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await say(f, '/destination');
    await say(f, 'Берлн');
    const old = button(f, 'select:0');
    await f.bot.handleUpdate(locationUpdate());
    await click(f, 'resume');
    await f.bot.handleUpdate(selection(old));
    expect(f.repo.users.get('1001')?.destination).toBeNull();
    await click(f, 'select:0');
    expect(f.repo.users.get('1001')?.destination?.city).toBe('Берлин');
    expect(f.geocoder.search).toHaveBeenCalledTimes(1);
    expect(f.repo.history).toHaveLength(0);
  });

  it('consumes a failed delete callback without automatically repeating the write', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await say(f, '/destination');
    const remove = button(f, 'delete');
    const save = vi.spyOn(f.repo, 'saveDestination').mockRejectedValueOnce(new Error('unknown outcome'));
    await f.bot.handleUpdate(selection(remove));
    expect(text(f)).toContain('Не удалось сохранить изменения');
    await f.bot.handleUpdate(selection(remove));
    expect(save).toHaveBeenCalledTimes(1);
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
    await say(f, '/destination');
    await click(f, 'delete');
    expect(save).toHaveBeenCalledTimes(2);
    expect(f.repo.users.get('1001')?.destination).toBeNull();
  });

  it('requires membership for text, search and callbacks, including after leaving during selection', async () => {
    const f = setup();
    f.transport.mockResolvedValueOnce({ ok: true, result: { status: 'left' } });
    await say(f, 'Берлин');
    expect(text(f)).toBe(TEXT.denied);
    f.geocoder.search.mockResolvedValue([{ ...candidate, exact: false }]);
    await say(f, '/checkin');
    await say(f, 'Берлн');
    const choose = button(f, 'select:0');
    f.transport.mockImplementationOnce(async (_previous, method, payload) => {
      f.calls.push({ method, payload });
      return { ok: true, result: true };
    }).mockResolvedValueOnce({ ok: true, result: { status: 'left' } });
    await f.bot.handleUpdate(selection(choose));
    expect(f.repo.history).toHaveLength(0);
    expect(text(f)).toBe(TEXT.denied);
  });

  it('requires an initial mark for plans and does not expose private actions in groups', async () => {
    const f = setup();
    await say(f, '/destination');
    expect(text(f)).toBe(TEXT.noLocation);
    f.calls.length = 0;
    for (const value of ['/checkin', '/find', '/destination', '/cancel', BUTTONS.checkin]) await f.bot.handleUpdate(messageUpdate(value));
    expect(f.calls).toHaveLength(0);
  });

  it('never executes the legacy skip callback or an inactive delete button', async () => {
    const f = setup();
    f.repo.users.set('1001', { ...current, destination: candidate });
    await f.bot.handleUpdate(selection({ data: 'place:012345abcdef:skip', messageId: 100, userId: 1001 }));
    await say(f, '/destination');
    const remove = button(f, 'delete');
    await say(f, '/start');
    await f.bot.handleUpdate(selection(remove));
    expect(f.repo.users.get('1001')?.destination).toEqual(candidate);
  });

  it('supports legacy labels and the group deep link without restoring obsolete behavior', async () => {
    const f = setup();
    await say(f, '📍 Указать место текстом');
    expect(text(f)).toBe(TEXT.current);
    await say(f, '🔎 Найти путешественников');
    expect(text(f)).toBe(TEXT.find);
    await say(f, '/start checkin');
    expect(text(f)).toBe(TEXT.current);
  });

  it.each(['current', 'destination', 'find'] as const)('uses actual unrestricted geocoding for country input in %s', async (mode) => {
    const f = setup();
    f.repo.users.set('1001', current);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [{ country: 'Грузия', country_code: 'ge', result_type: 'country', lat: 42, lon: 43,
      rank: { confidence: 1, match_type: 'full_match' } }] })));
    const adapter = new GeoapifyGeocoder('test-key', fetcher);
    f.geocoder.search.mockImplementation((query: string, only: boolean) => adapter.search(query, only));
    await say(f, mode === 'current' ? '/checkin' : mode === 'find' ? '/find' : '/destination');
    await say(f, 'Грузия');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.has('type')).toBe(false);
    if (mode === 'current') expect(f.repo.users.get('1001')).toMatchObject({ location: 'Грузия', city: '', region: '' });
    if (mode === 'destination') expect(f.repo.users.get('1001')?.destination).toMatchObject({ city: '', country: 'Грузия' });
    expect(text(f)).toContain('Грузия');
  });
});
