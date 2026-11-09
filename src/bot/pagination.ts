import { InlineKeyboard } from 'grammy';
import type { CityGroup } from '../domain/models.js';
import { displayText, EMPTY_LIST_TEXT } from './formatting.js';

export interface ListPage { text: string; keyboard: InlineKeyboard; index: number; totalPages: number }

export function parsePage(data: string): number | null {
  if (!/^list:(0|[1-9]\d{0,8})$/.test(data)) return null;
  return Number(data.slice(5));
}

export function renderListPage(groups: CityGroup[], requestedPage = 0): ListPage {
  const total = groups.reduce((sum, group) => sum + group.users.length, 0);
  if (!total) return { text: EMPTY_LIST_TEXT, keyboard: new InlineKeyboard([]), index: 0, totalPages: 1 };
  const prefix = `<b>Всего отметившихся: ${total}</b>\n\n`;
  const pages: string[] = [];
  let body = '';
  let count = 0;
  let lastGroup = '';
  for (const group of groups) {
    const header = `<b>${displayText(group.label)} — ${group.users.length}</b>\n`;
    for (const user of group.users) {
      const person = `• <a href="tg://user?id=${user.user_id}">${displayText(user.display_name, 128) || 'Участник'}</a>\n`;
      let addition = (lastGroup === group.place_key ? '' : `${body ? '\n' : ''}${header}`) + person;
      // Conservative bound on raw HTML also bounds Telegram's parsed text.
      if (count && (count >= 20 || prefix.length + body.length + addition.length > 3500)) {
        pages.push(prefix + body);
        body = '';
        count = 0;
        addition = header + person;
      }
      body += addition;
      count++;
      lastGroup = group.place_key;
    }
  }
  if (count) pages.push(prefix + body);
  const index = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 0, 0), pages.length - 1);
  const keyboard = pages.length > 1 ? new InlineKeyboard() : new InlineKeyboard([]);
  if (index > 0) keyboard.text('← Назад', `list:${index - 1}`);
  if (index < pages.length - 1) keyboard.text('Далее →', `list:${index + 1}`);
  return { text: `${pages[index]}\nСтраница ${index + 1} из ${pages.length}`, keyboard, index, totalPages: pages.length };
}
