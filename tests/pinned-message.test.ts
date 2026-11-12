import { GrammyError } from 'grammy';
import { expect, it, vi } from 'vitest';
import { PinnedMessageService } from '../src/services/pinned-message-service.js';
import { botFixture } from './bot-fixture.js';
import { current, env } from './fixtures.js';
import { captureLogs } from './logging-fixture.js';
import { formatList, formatListParts } from '../src/bot/formatting.js';

it('creates and stores one pin, serializes concurrent refreshes and edits after restart', async () => {
  const f = botFixture();
  f.repo.users.set(current.user_id, current);
  await Promise.all([f.pinned.update(), f.pinned.update()]);
  expect(f.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  expect(f.calls.find((c) => c.method === 'sendMessage')?.payload.text).toBe(formatList(await f.service.listGroups()));
  expect(f.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').every((c) =>
    (c.payload.link_preview_options as { is_disabled?: boolean } | undefined)?.is_disabled === true,
  )).toBe(true);
  expect(f.repo.settings.get('pinned_message_id')).toBe('100');
  await new PinnedMessageService(f.repo, f.service, f.bot.api, env.TELEGRAM_GROUP_ID).update();
  expect(f.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(2);
});

it('restores a deleted continuation after restart and unpins excess parts when the list shrinks', async () => {
  const f = botFixture();
  f.repo.users.set(current.user_id, { ...current, display_name: 'X'.repeat(5000) });
  await f.pinned.update();
  const oldExtra = Number(JSON.parse(f.repo.settings.get('pinned_message_ids')!)[0]);
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(async (...args) => original(...args));
  f.transport.mockImplementationOnce(async () => ({ ok: true, result: true }));
  f.transport.mockRejectedValueOnce(new GrammyError('edit', { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 'editMessageText', {}));
  const restarted = new PinnedMessageService(f.repo, f.service, f.bot.api, env.TELEGRAM_GROUP_ID);
  await restarted.update();
  const newExtra = Number(JSON.parse(f.repo.settings.get('pinned_message_ids')!)[0]);
  expect(newExtra).not.toBe(oldExtra);
  expect(f.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(3);
  f.repo.users.set(current.user_id, current);
  await restarted.update();
  expect(f.calls.filter((call) => call.method === 'unpinChatMessage').at(-1)?.payload.message_id).toBe(newExtra);
  expect(f.repo.settings.get('pinned_message_ids')).toBe('[]');
});

it('retries the same persisted continuation after a pin failure and does not drop IDs after failed unpinning', async () => {
  const f = botFixture();
  f.repo.users.set(current.user_id, { ...current, display_name: 'X'.repeat(5000) });
  const original = f.transport.getMockImplementation()!;
  let failPin = true;
  let failUnpin = true;
  f.transport.mockImplementation(async (...args) => {
    if (args[1] === 'pinChatMessage' && args[2].message_id === 101 && failPin) { failPin = false; throw new Error('permission'); }
    if (args[1] === 'unpinChatMessage' && failUnpin) { failUnpin = false; throw new Error('permission'); }
    return original(...args);
  });
  await f.pinned.update();
  expect(f.repo.settings.get('pinned_message_ids')).toBe('[101]');
  await f.pinned.update();
  expect(f.calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text)).toEqual(formatListParts(await f.service.listGroups()));
  f.repo.users.set(current.user_id, current);
  await f.pinned.update();
  expect(f.repo.settings.get('pinned_message_ids')).toBe('[101]');
  await f.pinned.update();
  expect(f.repo.settings.get('pinned_message_ids')).toBe('[]');
});

it('recreates a deleted message but does not create new ones on network or permission failures', async () => {
  const f = botFixture();
  f.repo.settings.set('pinned_message_id', '99');
  f.transport.mockRejectedValueOnce(new GrammyError('edit', { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 'editMessageText', {}));
  await f.pinned.update();
  expect(f.repo.settings.get('pinned_message_id')).toBe('100');
  expect(f.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  f.transport.mockRejectedValueOnce(new Error('network'));
  await f.pinned.update();
  expect(f.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
});

it('tolerates unchanged messages', async () => {
  const f = botFixture();
  f.repo.settings.set('pinned_message_id', '99');
  f.transport.mockRejectedValueOnce(new GrammyError('edit', { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {}));
  await expect(f.pinned.update()).resolves.toBeUndefined();
  expect(f.repo.settings.get('pinned_message_id')).toBe('99');
});

it('keeps data after a pin failure and retries the same message on the next update', async () => {
  const f = botFixture();
  f.repo.users.set(current.user_id, current);
  const capture = captureLogs();
  const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }), editMessageText: vi.fn().mockRejectedValueOnce(new GrammyError('edit', { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {})), pinChatMessage: vi.fn().mockRejectedValueOnce(new Error('permission')).mockResolvedValue(true), unpinChatMessage: vi.fn().mockResolvedValue(true) };
  const pinned = new PinnedMessageService(f.repo, f.service, api, env.TELEGRAM_GROUP_ID, capture.logger);
  await pinned.update();
  expect(f.repo.settings.get('pinned_message_id')).toBe('42');
  expect(f.repo.users.size).toBe(1);
  expect(capture.records).toContainEqual(expect.objectContaining({ event: 'pinned_message_update_failed' }));
  await pinned.update();
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  expect(api.pinChatMessage).toHaveBeenCalledTimes(2);
});

it('pins every part of an oversized list and preserves all names', async () => {
  const f = botFixture();
  f.repo.users.set(current.user_id, { ...current, display_name: 'X'.repeat(5000) });
  await expect(f.pinned.update()).resolves.toBeUndefined();
  const messages = f.calls.filter((call) => call.method === 'sendMessage');
  expect(messages).toHaveLength(2);
  expect(messages.map((call) => call.payload.text).join('').match(/X/g)).toHaveLength(5000);
  expect(f.calls.filter((call) => call.method === 'pinChatMessage')).toHaveLength(2);
  expect(f.repo.settings.get('pinned_message_ids')).toBe('[101]');
});
