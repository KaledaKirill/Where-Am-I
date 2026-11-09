export const HELP_TEXT = '/set Город, Страна — отметить своё местоположение.\n/list — показать список отметившихся по городам.';
export const EMPTY_LIST_TEXT = 'Пока никто не отметился. Напишите /set Город, Страна';
export const BOT_DESCRIPTION = 'Отметки путешественников: /set Город, Страна и /list.';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function displayText(value: string, maxLength = 180): string {
  const characters = [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()];
  return escapeHtml(characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join('')}…` : characters.join(''));
}

export function placeLabel(place: { location: string }): string {
  return displayText(place.location);
}
