import type { CurrentUser, Destination, LocationGroup, TelegramUser, TravelerSearchResult } from '../domain/models.js';
import { locationLabel } from '../domain/geocoder.js';
import { CHOICE_TITLES, TEXT } from './messages.js';
import type { InputMode } from './messages.js';
export { BUTTONS, BOT_DESCRIPTION, HELP_TEXT } from './messages.js';

export const START_TEXT = TEXT.start;
export const EMPTY_LIST_TEXT = TEXT.emptyList;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function placeLabel(place: { location: string }): string { return escapeHtml(place.location); }

export function formatHome(user: CurrentUser | null): string {
  if (!user) return TEXT.start;
  return '<b>Твоё место и планы</b>\n\n'
    + `📍 Место: ${escapeHtml(locationLabel(user))}\n\n`
    + `✈️ Планы: ${user.destination ? escapeHtml(locationLabel(user.destination)) : 'пока не указаны'}\n\n`
    + 'Выбери действие в меню ниже.';
}

export function formatSaved(location: string, plans = false): string {
  return `<b>✅ ${plans ? 'Планы сохранены' : 'Место сохранено'}</b>\n\n${plans ? '✈️' : '📍'} ${escapeHtml(location)}`;
}

export function formatPurpose(draft: string): string { return `${TEXT.choosePurpose}\n\n${escapeHtml(draft)}`; }

export function formatPlans(destination: Destination): string {
  return `${TEXT.plansTitle}\n\nНаправление: ${escapeHtml(locationLabel(destination))}\n\n${TEXT.plansQuestion}`;
}

export function formatChoices(mode: InputMode, count: number): string {
  return `<b>${CHOICE_TITLES[mode]}</b>\n\n${count > 1 ? TEXT.chooseMultiple : TEXT.chooseCorrection}`;
}

export function profileLink(user: TelegramUser): string {
  const link = user.username && /^[A-Za-z0-9_]+$/.test(user.username) ? `https://t.me/${user.username}` : `tg://user?id=${user.user_id}`;
  return `• <a href="${escapeHtml(link)}">${escapeHtml(user.display_name)}</a>`;
}

export function formatList(groups: LocationGroup[]): string {
  if (!groups.length) return EMPTY_LIST_TEXT;
  return '<b>🌍 Где участники</b>\n\nЗдесь показаны последние сохранённые отметки.\n\n'
    + groups.map((group) => `<b>📍 ${escapeHtml(group.label)}</b>\n\n${group.users.map(profileLink).join('\n')}`).join('\n\n');
}

export function formatListParts(groups: LocationGroup[]): string[] { return splitHtmlMessages(formatList(groups)); }

interface Section { heading: string; users: TelegramUser[]; empty?: string }
const LIST_TITLE = '<b>🌍 Где участники</b>\n\nЗдесь показаны последние сохранённые отметки.';
const SEARCH_FOOTER = 'Для нового поиска напиши другое место.';

/** Pages repeat section headings and retain the complete text of long linked names. */
function paginate(title: string, sections: Section[], footer = ''): string[] {
  const bodies: string[] = [];
  let body = title;
  let count = 0;
  let heading = '';
  const flush = () => { bodies.push(body); body = title; count = 0; heading = ''; };
  for (const section of sections) {
    const entries = section.users.length ? section.users.flatMap((user) => splitHtmlMessages(profileLink(user), 2800)) : [section.empty ?? ''];
    for (const entry of entries) {
      let prefix = heading === section.heading ? '\n' : `\n\n${section.heading}\n\n`;
      if ((section.users.length > 0 && count >= 10) || (count > 0 && visibleLength(body + prefix + entry) > 3800)) {
        flush();
        prefix = `\n\n${section.heading}\n\n`;
      }
      body += prefix + entry;
      heading = section.heading;
      if (section.users.length) count += 1;
    }
  }
  if (body !== title || !bodies.length) bodies.push(body);
  return bodies.map((part, index) => `${part}${bodies.length > 1 ? `\n\nСтраница ${index + 1} из ${bodies.length}` : ''}${footer ? `\n\n${footer}` : ''}`);
}

export function formatListPages(groups: LocationGroup[]): string[] {
  if (!groups.length) return [EMPTY_LIST_TEXT];
  return paginate(LIST_TITLE, groups.map((group) => ({ heading: `<b>📍 ${escapeHtml(group.label)}</b>`, users: group.users })));
}

export function formatSearch(label: string, result: TravelerSearchResult): string[] {
  const title = `<b>🔎 ${escapeHtml(label)}</b>`;
  if (!result.current.length && !result.planned.length) {
    return [`${title}\n\nПока нет участников с отметкой или планами поездки в это место.\n\nПопробуй поискать по региону или стране либо напиши другое место.`];
  }
  return paginate(title, [
    { heading: `<b>📍 Отметились здесь · ${result.current.length}</b>`, users: result.current, empty: 'Здесь пока никто не отметился.' },
    { heading: `<b>✈️ Планируют приехать · ${result.planned.length}</b>`, users: result.planned, empty: 'Поездок сюда пока никто не указал.' },
  ], SEARCH_FOOTER);
}

function visibleLength(text: string): number {
  return text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, 'x').length;
}

/** Split without cutting tags, entities or Unicode; close and reopen nested tags. */
export function splitHtmlMessages(text: string, limit = 4096): string[] {
  const parts: string[] = [];
  let current = '';
  let length = 0;
  const open: { name: string; tag: string }[] = [];
  const flush = () => {
    if (!length) return;
    parts.push(current + [...open].reverse().map(({ name }) => `</${name}>`).join(''));
    current = open.map(({ tag }) => tag).join('');
    length = 0;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const size = visibleLength(line);
    if (length && size <= limit && length + size > limit) flush();
    for (const token of line.match(/<[^>]*>|&(?:amp|lt|gt|quot|#39);|[^<&]|[<&]/gu) ?? []) {
      const opening = /^<([a-z]+)(?:\s[^>]*)?>$/.exec(token);
      if (opening) { open.push({ name: opening[1]!, tag: token }); current += token; continue; }
      if (/^<\/[a-z]+>$/.test(token)) { open.pop(); current += token; continue; }
      const width = token.startsWith('&') && token.endsWith(';') ? 1 : token.length;
      if (length + width > limit) flush();
      current += token;
      length += width;
    }
  }
  flush();
  return parts;
}

export class ListTooLongError extends Error {
  constructor() { super('list_too_long'); }
}

export function checkListLength(text: string): void {
  if (visibleLength(text) > 4096) throw new ListTooLongError();
}
