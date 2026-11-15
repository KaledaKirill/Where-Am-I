import { describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../src/bot/commands.js';
import { checkListLength, formatList, HELP_TEXT, START_TEXT } from '../src/bot/formatting.js';
import { env, current } from './fixtures.js';
import { botFixture, callbackUpdate, locationUpdate, membershipUpdate, messageUpdate } from './bot-fixture.js';

function setup() {
  const f = botFixture();
  registerCommands(f.bot, f.service, env.TELEGRAM_GROUP_ID, undefined, f.pinned);
  return f;
}

describe('Telegram commands', () => {
  it('shows four main actions and requests location only in check-in mode', async () => {
    const f = setup();
    await f.bot.handleUpdate(messageUpdate('/start', 1001));
    expect(f.calls.at(-1)?.payload.text).toBe(START_TEXT);
    const keyboard = f.calls.at(-1)?.payload.reply_markup as { keyboard: { text: string; request_location?: boolean }[][] };
    expect(keyboard.keyboard.flat().map((button) => button.text)).toEqual(['📍 Отметиться', '✈️ Мои планы', '🔎 Найти участников', '🌍 Кто где']);
    await f.bot.handleUpdate(messageUpdate('/help@WhereAmIBot', 1001));
    expect(f.calls.at(-1)?.payload.text).toBe(HELP_TEXT);
    await f.bot.handleUpdate(messageUpdate('/checkin', 1001));
    expect(f.calls.at(-1)?.payload.reply_markup).toMatchObject({ keyboard: [[{ text: '📍 Отправить геолокацию', request_location: true }], ...keyboard.keyboard, [{ text: '🏠 Главное меню' }]] });
    expect(f.repo.history).toHaveLength(0);
  });

  it('checks membership before geocoding, saves repeats, refreshes pin and confirms', async () => {
    const f = setup();
    await f.bot.handleUpdate(locationUpdate());
    await f.bot.handleUpdate(locationUpdate());
    expect(f.calls[0]?.method).toBe('getChatMember');
    expect(f.repo.users.size).toBe(1);
    expect(f.repo.history).toHaveLength(2);
    expect(f.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === env.TELEGRAM_GROUP_ID)).toHaveLength(1);
    expect(f.calls.at(-1)?.payload.text).toBe('<b>✅ Место сохранено</b>\n\n📍 Берлин, Германия');
    expect(f.calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === 1001)).toHaveLength(2);
    expect(f.repo.settings.get('pinned_message_id')).toBe('100');
    await f.bot.handleUpdate(messageUpdate('/list'));
    const pinnedText = f.calls.find((c) => c.method === 'editMessageText')?.payload.text;
    expect(f.calls.at(-1)?.payload.text).toBe(pinnedText);
    expect(f.calls.at(-1)?.payload.link_preview_options).toEqual({ is_disabled: true });
    expect(pinnedText).toBe(formatList(await f.service.listGroups()));
  });

  it.each(['left', 'kicked', 'restricted'])('does not geocode or save for nonmembers: %s', async (status) => {
    const f = setup();
    f.transport.mockResolvedValueOnce({ ok: true, result: { status, is_member: false } });
    await f.bot.handleUpdate(locationUpdate());
    expect(f.geocoder.reverse).not.toHaveBeenCalled();
    expect(f.repo.history).toHaveLength(0);
    expect(f.calls.at(-1)?.payload.text).toContain('Бот доступен участникам');
  });

  it('does not allow membership API failure to bypass authorization', async () => {
    const f = setup();
    f.transport.mockRejectedValueOnce(new Error('secret'));
    await f.bot.handleUpdate(locationUpdate());
    expect(f.geocoder.reverse).not.toHaveBeenCalled();
    expect(f.calls.at(-1)?.payload.text).toContain('временно недоступен');
  });

  it('does not create a partial check-in after geocoding or storage failure', async () => {
    const f = setup();
    f.geocoder.reverse.mockRejectedValueOnce(new Error('apiKey=secret'));
    await f.bot.handleUpdate(locationUpdate());
    expect(f.repo.history).toHaveLength(0);
    expect(f.calls.at(-1)?.payload.text).toContain('Не удалось определить');
    vi.spyOn(f.repo, 'saveLocation').mockRejectedValue(new Error('secret'));
    await f.bot.handleUpdate(locationUpdate());
    expect(f.calls.at(-1)?.payload.text).toContain('Не удалось сохранить изменения');
    expect(f.repo.history).toHaveLength(0);
  });

  it('confirms saved data after a pin error and retries on the next successful location', async () => {
    const f = setup();
    const getSetting = vi.spyOn(f.repo, 'getSetting').mockRejectedValueOnce(new Error('Sheets unavailable'));
    await f.bot.handleUpdate(locationUpdate());
    expect(f.repo.history).toHaveLength(1);
    expect(f.calls.at(-1)?.payload.text).toContain('✅ Место сохранено');
    await f.bot.handleUpdate(locationUpdate());
    expect(getSetting).toHaveBeenCalledTimes(3);
    expect(f.repo.history).toHaveLength(2);
    expect(f.repo.settings.get('pinned_message_id')).toBe('101');
  });

  it('ignores group locations, removed commands, ordinary text and edited live locations', async () => {
    const f = setup();
    for (const text of ['/start', '/help', '/me', '/set Берлин', 'Привет', '/list@AnotherBot']) await f.bot.handleUpdate(messageUpdate(text));
    await f.bot.handleUpdate(locationUpdate(-100123));
    await f.bot.handleUpdate(messageUpdate('/list', -999));
    const update = locationUpdate();
    if (!update.message) throw new Error('fixture');
    await f.bot.handleUpdate({ update_id: 4, edited_message: { ...update.message, edit_date: 2 } });
    expect(f.calls).toHaveLength(0);
    expect(f.repo.history).toHaveLength(0);
  });

  it('allows list in target group and member private chat, denies private outsiders', async () => {
    const f = setup();
    f.repo.users.set(current.user_id, current);
    await f.bot.handleUpdate(messageUpdate('/list'));
    const groupText = f.calls.at(-1)?.payload.text;
    await f.bot.handleUpdate(messageUpdate('/list', 1001));
    expect(f.calls.at(-1)?.payload.text).toBe(groupText);
    f.transport.mockResolvedValueOnce({ ok: true, result: { status: 'left' } });
    await f.bot.handleUpdate(messageUpdate('/list', 1001));
    expect(f.calls.at(-1)?.payload.text).toContain('Бот доступен участникам');
  });

  it('sends an oversized list in complete linked fragments without losing text', async () => {
    const f = setup();
    f.repo.users.set('1', { ...current, user_id: '1', display_name: 'А'.repeat(5000) });
    await expect(f.bot.handleUpdate(messageUpdate('/list'))).resolves.toBeUndefined();
    const texts = f.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.payload.text));
    expect(texts.length).toBeGreaterThan(1);
    texts.forEach((text) => expect(() => checkListLength(text)).not.toThrow());
    expect(texts.join('').match(/А/g)).toHaveLength(5000);
  });

  it('configures only list when added to the group, ignores departures and acknowledges old callbacks', async () => {
    const f = setup();
    await f.bot.handleUpdate(membershipUpdate());
    expect(f.calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(2);
    expect(f.calls[0]?.payload.commands).toEqual([{ command: 'list', description: 'Где участники группы' }]);
    await f.bot.handleUpdate(membershipUpdate(false));
    await f.bot.handleUpdate(callbackUpdate());
    expect(f.calls.at(-1)?.method).toBe('answerCallbackQuery');
    expect(f.repo.history).toHaveLength(0);
  });

  it('refreshes the group menu and pin when later promoted to administrator', async () => {
    const f = setup();
    f.repo.users.set(current.user_id, current);
    const update = membershipUpdate();
    if (!update.my_chat_member) throw new Error('fixture');
    const user = update.my_chat_member.new_chat_member.user;
    update.my_chat_member.old_chat_member = { status: 'member', user };
    update.my_chat_member.new_chat_member = {
      status: 'administrator', user, can_be_edited: false, is_anonymous: false,
      can_manage_chat: true, can_delete_messages: false, can_manage_video_chats: false,
      can_restrict_members: false, can_promote_members: false, can_change_info: false,
      can_invite_users: false, can_post_stories: false, can_edit_stories: false,
      can_delete_stories: false, can_pin_messages: true, can_send_welcome_messages: false,
    };
    await f.bot.handleUpdate(update);
    expect(f.calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(2);
    expect(f.calls.some((c) => c.method === 'pinChatMessage')).toBe(true);
    expect(f.repo.history).toHaveLength(0);
  });
});
