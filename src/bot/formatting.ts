import type { LocationGroup, TelegramUser, TravelerSearchResult } from '../domain/models.js';

export const HELP_TEXT = `📍 Где ты сейчас?
Нажми «📍 Отправить геолокацию» или выбери геопозицию через скрепку в личном чате с ботом.
Можно написать населённый пункт и страну: Москва Россия, Нижний Новгород Россия, Берлин Германия.

✈️ После отметки укажи пункт назначения в том же формате Город Страна, например: Москва Россия. Населённый пункт и страна обязательны. Или нажми «Пока никуда не планирую», чтобы очистить планы.
/destination — изменить планы без новой отметки.

/list — все текущие местоположения участников.
/find — найти тех, кто уже здесь или собирается приехать. Например: Россия, Москва, Тверская область, Москва Россия.
/cancel — отменить ввод, сохранив уже записанные данные.`;
export const START_TEXT = `Привет! Узнай, где путешественники нашей группы, и найди попутчиков.\n\n${HELP_TEXT}`;
export const EMPTY_LIST_TEXT = 'Пока никто не отметился. Отправьте боту геолокацию или населённый пункт и страну в личном чате.';
export const BOT_DESCRIPTION = 'Отметьтесь геолокацией или текстом «Город Страна», укажите планы. /list — где участники сейчас, /find — поиск путешественников.';

export const BUTTONS = { location: '📍 Отправить геолокацию', text: '📍 Указать место текстом', find: '🔎 Найти путешественников', destination: '✈️ Изменить планы', list: '🌍 Список путешественников' } as const;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function placeLabel(place: { location: string }): string { return escapeHtml(place.location); }

export function profileLink(user: TelegramUser): string {
  const link = user.username && /^[A-Za-z0-9_]+$/.test(user.username) ? `https://t.me/${user.username}` : `tg://user?id=${user.user_id}`;
  return `• <a href="${escapeHtml(link)}">${escapeHtml(user.display_name)}</a>`;
}

export function formatList(groups: LocationGroup[]): string {
  return ['🌍 Где сейчас путешественники?', '', groups.length ? groups.map((group) =>
    `📍 ${escapeHtml(group.label)}\n${group.users.map(profileLink).join('\n')}`,
  ).join('\n\n') : EMPTY_LIST_TEXT].join('\n');
}

export function formatSearch(label: string, result: TravelerSearchResult): string[] {
  return splitHtmlMessages([
    `🔎 ${escapeHtml(label)}`, '',
    '📍 Сейчас находятся здесь', result.current.length ? result.current.map(profileLink).join('\n') : 'Пока никого нет.', '',
    '✈️ Планируют сюда приехать', result.planned.length ? result.planned.map(profileLink).join('\n') : 'Пока никто не планирует.',
  ].join('\n'));
}

export function formatListParts(groups: LocationGroup[]): string[] { return splitHtmlMessages(formatList(groups)); }

function visibleLength(text: string): number {
  return text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, 'x').length;
}

/** Pack complete lines first; an exceptionally long name is split into linked
 * fragments without cutting an HTML entity, tag, or Unicode code point. */
export function splitHtmlMessages(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let length = 0;
  const open: string[] = [];
  const flush = () => {
    if (!length) return;
    parts.push(current + open.map(() => '</a>').join(''));
    current = open.join('');
    length = 0;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const size = visibleLength(line);
    if (length && size <= 4096 && length + size > 4096) flush();
    for (const token of line.match(/<[^>]*>|&(?:amp|lt|gt|quot|#39);|[^<&]|[<&]/gu) ?? []) {
      if (token.startsWith('<a ')) { open.push(token); current += token; continue; }
      if (token === '</a>') { open.pop(); current += token; continue; }
      const width = token.startsWith('&') && token.endsWith(';') ? 1 : token.length;
      if (length + width > 4096) flush();
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
