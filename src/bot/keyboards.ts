import { InlineKeyboard, Keyboard } from 'grammy';
import { BUTTONS } from './messages.js';
import { locationLabel } from '../domain/geocoder.js';
import type { PlaceCandidate } from '../domain/models.js';

export function mainKeyboard(current = false): Keyboard {
  const keyboard = new Keyboard();
  if (current) keyboard.requestLocation(BUTTONS.location).row();
  keyboard.text(BUTTONS.checkin).text(BUTTONS.destination).row().text(BUTTONS.find).text(BUTTONS.list);
  if (current) keyboard.row().text(BUTTONS.home);
  return keyboard.resized().persistent().oneTime(false);
}

export function homeButton(keyboard: InlineKeyboard, token: string): InlineKeyboard {
  return keyboard.row().text(BUTTONS.home, `ui:${token}:home`);
}

export function plansKeyboard(token: string): InlineKeyboard {
  return homeButton(new InlineKeyboard().text(BUTTONS.edit, `ui:${token}:edit`).row()
    .text(BUTTONS.remove, `ui:${token}:delete`), token);
}

export function purposeKeyboard(token: string): InlineKeyboard {
  return homeButton(new InlineKeyboard().text('📍 Отметиться здесь', `ui:${token}:current`).row()
    .text('✈️ Добавить в планы', `ui:${token}:destination`).row()
    .text(BUTTONS.find, `ui:${token}:find`), token);
}

export function pageKeyboard(token: string, page: number, total: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text('← Назад', `ui:${token}:page:${page - 1}`);
  if (page + 1 < total) keyboard.text('Далее →', `ui:${token}:page:${page + 1}`);
  return homeButton(keyboard, token);
}

export function groupKeyboard(username: string): InlineKeyboard {
  return new InlineKeyboard().url('📍 Отметиться в боте', `https://t.me/${username}?start=checkin`);
}

export function nearbyKeyboard(token: string): InlineKeyboard {
  return homeButton(new InlineKeyboard().text(BUTTONS.nearby, `ui:${token}:nearby`), token);
}

export function choicesKeyboard(token: string, candidates: PlaceCandidate[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  candidates.forEach((candidate, index) => keyboard.text(locationLabel(candidate), `ui:${token}:select:${index}`).row());
  return homeButton(keyboard, token);
}

export function geoKeyboard(token: string, previousMode?: string): InlineKeyboard {
  const resume = previousMode === 'find' ? 'Продолжить поиск'
    : previousMode === 'plans' ? 'Вернуться к планам' : 'Продолжить ввод планов';
  return homeButton(new InlineKeyboard().text('Обновить место', `ui:${token}:confirm`).row()
    .text(resume, `ui:${token}:resume`), token);
}
