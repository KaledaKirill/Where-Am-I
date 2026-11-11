import { Bot } from 'grammy';
import type { Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { vi } from 'vitest';
import { LocationService } from '../src/services/location-service.js';
import { env, MemoryRepository, place, coordinates } from './fixtures.js';
import { PinnedMessageService } from '../src/services/pinned-message-service.js';

export function botFixture() {
  const info = { id: 123456789, is_bot: true as const, first_name: 'Where Am I', username: 'WhereAmIBot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo: info });
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const transport = vi.fn(async (_previous: unknown, method: string, payload: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }> => {
    calls.push({ method, payload });
    if (method === 'getChatMember') return { ok: true, result: { status: 'member', user: { id: 1001, is_bot: false, first_name: 'Anna' } } };
    if (method === 'sendMessage' || method === 'editMessageText') return { ok: true, result: {
      message_id: 100, date: 1, chat: { id: -100123, type: 'supergroup', title: 'Travellers' }, from: info, text: payload.text,
    } };
    return { ok: true, result: true };
  });
  bot.api.config.use(transport as unknown as Transformer);
  const repo = new MemoryRepository();
  const geocoder = { reverse: vi.fn().mockResolvedValue(place) };
  const service = new LocationService(repo, geocoder);
  const pinned = new PinnedMessageService(repo, service, bot.api, env.TELEGRAM_GROUP_ID);
  return { bot, repo, service, calls, transport, info, geocoder, pinned };
}

export function messageUpdate(text: string, chatId = -100123, userId = 1001): Update {
  const command = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  return {
    update_id: 1,
    message: {
      message_id: 10, date: 1, chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'Anna' } : { id: chatId, type: 'supergroup', title: 'Travellers' },
      from: { id: userId, is_bot: false, first_name: 'Анна <&>', username: 'anna' },
      text, entities: command,
    },
  } as Update;
}

export function callbackUpdate(data = 'list:1', chatId = -100123, botId = 123456789): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-id', chat_instance: 'instance', data,
      from: { id: 999, is_bot: false, first_name: 'Другой участник' },
      message: {
        message_id: 100, date: 1, chat: { id: chatId, type: 'supergroup', title: 'Travellers' },
        from: { id: botId, is_bot: true, first_name: 'Where Am I' }, text: 'Список',
      },
    },
  };
}

export function locationUpdate(chatId = 1001): Update {
  const update = messageUpdate('', chatId);
  if (!update.message) throw new Error('fixture');
  delete update.message.text;
  update.message.location = coordinates;
  return update;
}

export function membershipUpdate(joining = true, chatId = -100123): Update {
  const user = { id: 123456789, is_bot: true as const, first_name: 'Where Am I' };
  return {
    update_id: 3,
    my_chat_member: {
      chat: { id: chatId, type: 'supergroup', title: 'Travellers' },
      from: { id: 1001, is_bot: false, first_name: 'Admin' }, date: 1,
      old_chat_member: { status: joining ? 'left' : 'member', user },
      new_chat_member: { status: joining ? 'member' : 'left', user },
    },
  };
}
