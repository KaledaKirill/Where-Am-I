import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/bot/commands.js';
import { HELP_TEXT } from '../src/bot/formatting.js';
import { current, env } from './fixtures.js';
import { botFixture, callbackUpdate, membershipUpdate, messageUpdate } from './bot-fixture.js';

function setup() {
  const f = botFixture();
  registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID);
  return f;
}

describe('Telegram commands', () => {
  it('configures menus when added after deployment and immediately handles commands', async () => {
    const f = setup();
    await f.bot.handleUpdate(membershipUpdate());
    const menus = f.calls.filter((call) => call.method === 'setMyCommands');
    expect(menus).toHaveLength(2);
    expect(menus[0]?.payload).toMatchObject({ scope: { type: 'chat', chat_id: '-100123' }, language_code: 'ru' });
    expect(f.repo.history).toHaveLength(0);
    await f.bot.handleUpdate(messageUpdate('/help'));
    expect(f.calls.at(-1)?.payload.text).toBe(HELP_TEXT);
  });

  it('continues handling commands if configuring menus on join fails', async () => {
    const f = setup();
    f.transport.mockRejectedValueOnce(new Error('menu unavailable'));
    await expect(f.bot.handleUpdate(membershipUpdate())).resolves.toBeUndefined();
    await f.bot.handleUpdate(messageUpdate('/help'));
    expect(f.calls.at(-1)?.payload.text).toBe(HELP_TEXT);
  });

  it('ignores bot departures and does not configure menus in other groups', async () => {
    const f = setup();
    await f.bot.handleUpdate(membershipUpdate(false));
    await f.bot.handleUpdate(membershipUpdate(true, -999));
    expect(f.calls).toHaveLength(0);
    expect(f.repo.history).toHaveLength(0);
  });

  it.each(['/help', '/start', '/help@WhereAmIBot'])('returns exactly two required lines for %s', async (command) => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate(command));
    expect(f.calls[0]?.payload.text).toBe(HELP_TEXT);
    expect(f.repo.history).toHaveLength(0);
  });

  it('accepts mentions, escapes success and keeps repeated check-ins in history', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('/set@WhereAmIBot Берлин, Германия'));
    await f.bot.handleUpdate(messageUpdate('/set Берлин, Германия'));
    expect(f.repo.users.size).toBe(1);
    expect(f.repo.history).toHaveLength(2);
    expect(f.calls[0]?.payload.text).toBe('✅ Отметка сохранена: Берлин, Германия');
    await f.bot.handleUpdate(messageUpdate('/list'));
    expect(f.calls.at(-1)?.payload.text).toContain('Анна &lt;&amp;&gt;');
  });

  it('preserves unverified text and escapes it in every displayed location', async () => {
    const f = setup();
    const location = '<b>Выдуманный город</b>, Страна & мир';
    await f.bot.handleUpdate(messageUpdate(`/set ${location}`));
    expect(f.repo.users.get('1001')?.location).toBe(location);
    expect(f.calls.at(-1)?.payload.text).toContain('&lt;b&gt;Выдуманный город&lt;/b&gt;, Страна &amp; мир');
    await f.bot.handleUpdate(messageUpdate('/me'));
    expect(f.calls.at(-1)?.payload.text).toContain('&lt;b&gt;Выдуманный город&lt;/b&gt;, Страна &amp; мир');
    await f.bot.handleUpdate(messageUpdate('/list'));
    expect(f.calls.at(-1)?.payload.text).toContain('&lt;b&gt;Выдуманный город&lt;/b&gt;, Страна &amp; мир');
  });

  it('ignores other bots, ordinary messages and departures', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('/set@AnotherBot Берлин'));
    await f.bot.handleUpdate(messageUpdate('Я сейчас в Берлине'));
    await f.bot.handleUpdate({ update_id: 5, message: {
      message_id: 20, date: 1, chat: { id: -100123, type: 'supergroup', title: 'Travellers' },
      from: { id: 1001, is_bot: false, first_name: 'Анна' },
      left_chat_member: { id: 1001, is_bot: false, first_name: 'Анна' },
    } });
    expect(f.calls).toHaveLength(0);
  });

  it('does not access repositories in private and unauthorized chats', async () => {
    const f = setup();
    const read = vi.spyOn(f.repo, 'listUsers');
    const me = vi.spyOn(f.repo, 'getUser');
    for (const id of [1001, -999]) for (const command of ['/set Берлин', '/list', '/me', '/help']) {
      await f.bot.handleUpdate(messageUpdate(command, id));
    }
    await f.bot.handleUpdate(callbackUpdate('list:1', -999));
    expect(read).not.toHaveBeenCalled();
    expect(me).not.toHaveBeenCalled();
    expect(f.calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
  });

  it('rejects anonymous senders and messages without a user', async () => {
    const f = setup();
    const anonymous = messageUpdate('/set Берлин Германия');
    if (!anonymous.message) throw new Error('fixture');
    anonymous.message.sender_chat = { id: -100123, type: 'supergroup', title: 'Travellers' };
    await f.bot.handleUpdate(anonymous);
    delete anonymous.message.sender_chat;
    Reflect.deleteProperty(anonymous.message, 'from');
    await f.bot.handleUpdate(anonymous);
    expect(f.repo.history).toHaveLength(0);
  });

  it('shows current location and empty states from storage', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('/me'));
    expect(f.calls.at(-1)?.payload.text).toContain('пока нет отметки');
    await f.bot.handleUpdate(messageUpdate('/list'));
    expect(f.calls.at(-1)?.payload.text).toContain('Пока никто не отметился');
    f.repo.users.set('1001', current);
    await f.bot.handleUpdate(messageUpdate('/me'));
    expect(f.calls.at(-1)?.payload.text).toBe('Ваша последняя отметка: Берлин, Германия\nОбновлено: 09.11.2026');
  });

  it('never confirms success after failed storage', async () => {
    const f = setup();
    vi.spyOn(f.repo, 'saveLocation').mockRejectedValue(new Error('private key'));
    await f.bot.handleUpdate(messageUpdate('/set Берлин Германия'));
    expect(f.calls[0]?.payload.text).toContain('временно недоступен');
    expect(f.calls[0]?.payload.text).not.toContain('сохранена');
    expect(f.calls[0]?.payload.text).not.toContain('private key');
  });

  it.each(['/set', '/set https://example.org', `/set ${'А'.repeat(121)}`])('does not write invalid input %s', async (command) => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate(command));
    expect(f.repo.history).toHaveLength(0);
    expect(f.calls[0]?.payload.text).not.toContain('сохранена');
  });

  it('allows another member to paginate and re-reads current Users without writes', async () => {
    const f = setup();
    for (let i = 1; i <= 25; i++) f.repo.users.set(String(i), { ...current, user_id: String(i) });
    const read = vi.spyOn(f.repo, 'listUsers');
    const write = vi.spyOn(f.repo, 'saveLocation');
    await f.bot.handleUpdate(callbackUpdate());
    expect(f.calls[0]?.method).toBe('editMessageText');
    expect(f.calls[0]?.payload.text).toContain('Страница 2 из 2');
    expect(f.calls.at(-1)?.method).toBe('answerCallbackQuery');
    f.repo.users.clear();
    await f.bot.handleUpdate(callbackUpdate());
    expect(f.calls.findLast((call) => call.method === 'editMessageText')?.payload.text).toContain('Пока никто');
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
  });

  it('acknowledges corrupt callbacks and foreign bot messages without reading data', async () => {
    const f = setup();
    const read = vi.spyOn(f.repo, 'listUsers');
    await f.bot.handleUpdate(callbackUpdate('list:-1'));
    await f.bot.handleUpdate(callbackUpdate('list:1', -100123, 999));
    const inaccessible = callbackUpdate();
    if (!inaccessible.callback_query?.message) throw new Error('fixture');
    inaccessible.callback_query.message = { message_id: 100, date: 0, chat: { id: -100123, type: 'supergroup', title: 'Travellers' } };
    await f.bot.handleUpdate(inaccessible);
    expect(read).not.toHaveBeenCalled();
    expect(f.calls.map((call) => call.method)).toEqual(['answerCallbackQuery', 'answerCallbackQuery', 'answerCallbackQuery']);
  });

  it('acknowledges callback failures and tolerates unchanged messages', async () => {
    const f = setup();
    vi.spyOn(f.repo, 'listUsers').mockRejectedValueOnce(new Error('storage'));
    await f.bot.handleUpdate(callbackUpdate());
    expect(f.calls.at(-1)?.payload.text).toContain('временно недоступен');
    f.transport.mockRejectedValueOnce(new GrammyError('editMessageText', {
      ok: false, error_code: 400, description: 'Bad Request: message is not modified',
    }, 'editMessageText', {}));
    await f.bot.handleUpdate(callbackUpdate());
    expect(f.calls.at(-1)?.method).toBe('answerCallbackQuery');
    expect(f.calls.at(-1)?.payload.text).toBeUndefined();
  });
});
