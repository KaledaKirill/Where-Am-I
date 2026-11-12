import { expect, it } from 'vitest';
import { checkListLength, formatList, formatListParts, splitHtmlMessages } from '../src/bot/formatting.js';
import { current } from './fixtures.js';

it('escapes names and locations, links profiles with and without username, includes everyone without coordinates', () => {
  const text = formatList([{ key: 'x', label: '<Город> & Страна', users: [
    { ...current, display_name: '<Иван> & друг' },
    { ...current, user_id: '2', display_name: 'Мария', username: null },
  ] }]);
  expect(text).toContain('📍 &lt;Город&gt; &amp; Страна');
  expect(text).toContain('<a href="https://t.me/anna">&lt;Иван&gt; &amp; друг</a>');
  expect(text).toContain('<a href="tg://user?id=2">Мария</a>');
  expect(text).not.toContain(String(current.latitude));
  expect(text).not.toContain('Страница');
  expect(formatList([])).toContain('Пока никто');
});

it('preserves every user, entity, Unicode code point and complete link when splitting messages', () => {
  const groups = [{ key: 'x', label: '<Москва> & Россия', users: Array.from({ length: 100 }, (_, index) => ({
    ...current, user_id: String(index + 1), username: null, display_name: `Участник ${index} ${'&😀'.repeat(20)}`,
  })) }];
  const parts = formatListParts(groups);
  expect(parts.length).toBeGreaterThan(1);
  parts.forEach((text) => {
    expect(() => checkListLength(text)).not.toThrow();
    expect(text.match(/<a /g)?.length ?? 0).toBe(text.match(/<\/a>/g)?.length ?? 0);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
  expect(parts.join('')).toBe(formatList(groups));
  expect(parts.join('').match(/tg:\/\/user\?id=/g)).toHaveLength(100);
  expect(splitHtmlMessages('a'.repeat(4096))).toEqual(['a'.repeat(4096)]);
  expect(splitHtmlMessages('a'.repeat(4097))).toEqual(['a'.repeat(4096), 'a']);
  expect(splitHtmlMessages('a'.repeat(4095) + '😀')).toEqual(['a'.repeat(4095), '😀']);
  expect(formatListParts([])).toEqual([formatList([])]);
});

it('does not truncate the list and checks the visible Telegram length', () => {
  const text = formatList([{ key: 'x', label: 'Место', users: Array.from({ length: 30 }, (_, i) => ({ ...current, user_id: String(i + 1), display_name: '&'.repeat(30) })) }]);
  expect(text.match(/• /g)).toHaveLength(30);
  expect(text).not.toContain('…');
  expect(() => checkListLength(text)).not.toThrow();
  expect(() => checkListLength('x'.repeat(4097))).toThrow('list_too_long');
});
