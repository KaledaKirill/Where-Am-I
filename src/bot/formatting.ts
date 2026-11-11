import type { LocationGroup } from '../domain/models.js';

export const HELP_TEXT = 'Чтобы отметиться, отправьте боту геолокацию в личном чате: нажмите «📍 Отправить геолокацию» или выберите геопозицию через скрепку.\n/list — текущий список путешественников.';
export const START_TEXT = `Привет! Здесь можно узнать, где сейчас участники нашей группы.\n${HELP_TEXT}`;
export const EMPTY_LIST_TEXT = 'Пока никто не отметился. Отправьте боту геолокацию в личном чате.';
export const BOT_DESCRIPTION = 'Отправьте геолокацию в личном чате, чтобы отметиться. /list — список путешественников.';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function placeLabel(place: { location: string }): string { return escapeHtml(place.location); }

export function formatList(groups: LocationGroup[]): string {
  return ['🌍 Где сейчас путешественники?', '', groups.length ? groups.map((group) =>
    `📍 ${escapeHtml(group.label)}\n${group.users.map((user) => {
      const link = user.username && /^[A-Za-z0-9_]+$/.test(user.username) ? `https://t.me/${user.username}` : `tg://user?id=${user.user_id}`;
      return `• <a href="${escapeHtml(link)}">${escapeHtml(user.display_name)}</a>`;
    }).join('\n')}`,
  ).join('\n\n') : EMPTY_LIST_TEXT].join('\n');
}

export class ListTooLongError extends Error {
  constructor() { super('list_too_long'); }
}

export function checkListLength(text: string): void {
  const visible = text.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, 'x');
  if (visible.length > 4096) throw new ListTooLongError();
}
