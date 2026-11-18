import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import type { CameraOptions } from 'maplibre-gl';
import type { MapData, MapEvent, MapMode, MapSession } from '../types.js';
import { scene } from './geometry.js';
import { TravelMap } from './map.js';
import { DetailPanel, element, ParticipantPanel } from './panels.js';

interface WebApp {
  initData: string;
  colorScheme?: 'dark' | 'light';
  ready(): void;
  expand(): void;
  onEvent(name: 'themeChanged' | 'viewportChanged', callback: () => void): void;
  isVersionAtLeast?(version: string): boolean;
  disableVerticalSwipes?(): void;
  openTelegramLink?(link: string): void;
  BackButton?: { onClick(callback: () => void): void; show(): void; hide(): void };
}

const telegram = (window as Window & { Telegram?: { WebApp: WebApp } }).Telegram?.WebApp;
const preference = window.matchMedia('(prefers-color-scheme: dark)');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const mineButton = element<HTMLButtonElement>('mine');
const filterButton = element<HTMLButtonElement>('participants');
const placesButton = element<HTMLButtonElement>('places');
const checkIn = element<HTMLAnchorElement>('check-in');
const retry = element<HTMLButtonElement>('retry');
const zoomIn = element<HTMLButtonElement>('zoom-in');
const zoomOut = element<HTMLButtonElement>('zoom-out');
const fit = element<HTMLButtonElement>('fit');
const dialogs = [...document.querySelectorAll('dialog')];
const empty: MapData = { participants: [], travelers: [], resolvingPlaces: false };

let map: TravelMap | undefined;
let session: MapSession | undefined;
let data = empty;
let mode: Exclude<MapMode, 'mine'> = 'current';
let mine = false;
let previousCamera: CameraOptions | undefined;
let selection: Set<string> | null = null;
let activeRequest: AbortController | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let dark = telegram?.colorScheme ? telegram.colorScheme === 'dark' : preference.matches;
let rendered = scene([], dark);
let mapUnavailable = false;
let baseUnavailable = false;
let loaded = false;

class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal, token?: string): Promise<T> {
  const response = await fetch(`/api/map/${path}`, {
    method: 'POST', body: JSON.stringify(body), signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json() as Promise<T>;
}

function showStatus(title?: string, options: { retry?: boolean; checkIn?: boolean } = {}) {
  element('status').hidden = !title;
  element('status-title').textContent = title ?? '';
  retry.hidden = !options.retry;
  checkIn.hidden = !options.checkIn;
}

function mapNote() {
  const note = element('map-note');
  note.textContent = mapUnavailable ? 'Карта недоступна на этом устройстве. Открой список «Места».'
    : baseUnavailable ? 'Подложка карты временно недоступна.'
      : data.resolvingPlaces ? 'Уточняем точки мест…'
        : rendered.groups.size && !rendered.markers.features.length ? 'Метки доступны в списке «Места».' : '';
  note.hidden = !note.textContent;
}

function syncBack() {
  if (mine || dialogs.some(dialog => dialog.open)) telegram?.BackButton?.show();
  else telegram?.BackButton?.hide();
}

function openDialog(dialog: HTMLDialogElement) {
  if (dialog.open) dialog.querySelector<HTMLButtonElement>('.close')?.focus();
  else dialog.showModal();
  syncBack();
}

const detail = new DetailPanel(openDialog);
const participants = new ParticipantPanel(openDialog, ids => { selection = ids; void refresh('fit'); });

function openPlace(id: string) {
  const group = rendered.groups.get(id);
  if (group) detail.place(group, data.participants, dark);
}

function openPlaces(ids?: string[]) {
  if (ids?.length === 1) { openPlace(ids[0]!); return; }
  const shown = ids ? ids.flatMap(id => {
    const group = rendered.groups.get(id);
    return group ? [group] : [];
  }) : [...rendered.groups.values()];
  detail.places(shown, openPlace);
}

function fitSelection() {
  map?.fit([...rendered.groups.values()].flatMap(group => group.place.point ? [group.place.point] : []));
}

function syncControls() {
  modeButtons.forEach(button => {
    button.disabled = !loaded;
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  mineButton.disabled = !loaded;
  mineButton.setAttribute('aria-pressed', String(mine));
  filterButton.disabled = !loaded;
  filterButton.hidden = mine;
  element('modes').hidden = mine;
  element('my-tools').hidden = !mine;
  element<HTMLButtonElement>('timeline').disabled = !rendered.groups.size;
  const total = data.participants.length;
  const visible = selection ? data.participants.filter(person => selection?.has(person.id)).length : total;
  const count = element('participant-count');
  count.textContent = visible === total ? String(total) : `${visible}/${total}`;
  count.hidden = !loaded;
  placesButton.disabled = !rendered.groups.size;
  zoomIn.disabled = !map;
  zoomOut.disabled = !map;
  fit.disabled = !map;
  element('history-legend').hidden = !mine && mode === 'current';
  element('plan-legend').hidden = mine || mode !== 'plans';
  syncBack();
}

function redraw() {
  rendered = scene(data.travelers, dark);
  map?.render(rendered);
  syncControls();
  mapNote();
}

function showDataStatus() {
  if (mine && !rendered.groups.size) showStatus('У тебя пока нет отметок', { checkIn: true });
  else if (!rendered.groups.size) {
    if (data.participants.length) showStatus('Участники скрыты');
    else showStatus('В группе пока нет отметок', { checkIn: true });
  } else showStatus();
}

type CameraAction = 'fit' | 'restore' | 'hold';
async function refresh(camera: CameraAction, attempt = 0) {
  if (!session) return;
  clearTimeout(refreshTimer);
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  if (!attempt) {
    data = { ...data, travelers: [], resolvingPlaces: false };
    redraw();
    showStatus('Загружаем отметки…');
  }
  try {
    const result = await post<MapData>('data', {
      mode: mine ? 'mine' : mode,
      ...(!mine && selection ? { participantIds: [...selection] } : {}),
    }, request.signal, session.token);
    if (request.signal.aborted) return;
    const wasEmpty = !rendered.markers.features.length;
    data = result;
    loaded = true;
    redraw();
    if (camera === 'restore' && previousCamera) map?.restore(previousCamera);
    else if (camera === 'fit' || (attempt > 0 && wasEmpty && rendered.markers.features.length)) fitSelection();
    showDataStatus();
    if (result.resolvingPlaces && attempt < 6) refreshTimer = setTimeout(() => { void refresh('hold', attempt + 1); }, 2_500);
  } catch (error) {
    if (request.signal.aborted) return;
    dialogs.forEach(dialog => { if (dialog.open) dialog.close(); });
    const unauthorized = error instanceof HttpError && error.status === 401;
    const forbidden = error instanceof HttpError && error.status === 403;
    if (unauthorized || forbidden) { session = undefined; loaded = false; }
    data = empty;
    redraw();
    showStatus(forbidden ? 'Карта доступна участникам группы' : unauthorized ? 'Открой карту заново из бота'
      : 'Не удалось загрузить отметки', { retry: !forbidden && !unauthorized });
  }
}

function setMine(value: boolean) {
  if (value === mine) return;
  if (value) previousCamera = map?.camera();
  mine = value;
  void refresh(value ? 'fit' : 'restore');
}

function setTheme() {
  dark = telegram?.colorScheme ? telegram.colorScheme === 'dark' : preference.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (map && session) map.theme(dark ? session.darkStyleUrl : session.styleUrl, dark);
  redraw();
}

function sizeSheet() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const height = viewport.height;
  document.documentElement.style.setProperty('--sheet-height', `${height * (height < 530 ? .96 : .8)}px`);
  document.documentElement.style.setProperty('--sheet-offset', `${Math.max(0, window.innerHeight - height - viewport.offsetTop)}px`);
}

async function launch() {
  if (!telegram?.initData) { showStatus('Открой карту из Telegram'); return; }
  showStatus('Открываем карту…');
  try {
    session = await post<MapSession>('session', { initData: telegram.initData });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 0;
    showStatus(status === 403 ? 'Карта доступна участникам группы' : status === 401
      ? 'Открой карту заново из бота' : 'Карта временно недоступна', { retry: status !== 401 && status !== 403 });
    return;
  }
  checkIn.href = session.checkInUrl;
  if (!map) {
    try {
      map = new TravelMap(element('map'), dark ? session.darkStyleUrl : session.styleUrl, dark, openPlaces, unavailable => {
        baseUnavailable = unavailable;
        mapNote();
      });
    } catch { mapUnavailable = true; }
  }
  await refresh('fit');
}

for (const dialog of dialogs) {
  dialog.querySelector<HTMLButtonElement>('.close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', syncBack);
}
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const next = button.dataset.mode as typeof mode;
    if (next === mode) return;
    mode = next;
    void refresh('fit');
  });
}
mineButton.addEventListener('click', () => setMine(!mine));
filterButton.addEventListener('click', () => participants.open(data.participants, selection, dark));
element('timeline').addEventListener('click', () => {
  const own = data.travelers.find(traveler => traveler.id === session?.viewerId);
  const history = own?.history ?? [];
  const events: MapEvent[] = own?.current && !history.some(event => event.isLatest) ? [...history, own.current] : history;
  detail.timeline(events, event => { if (event.place.point) map?.fit([event.place.point]); });
});
placesButton.addEventListener('click', () => openPlaces());
zoomIn.addEventListener('click', () => map?.zoom(1));
zoomOut.addEventListener('click', () => map?.zoom(-1));
fit.addEventListener('click', fitSelection);
retry.addEventListener('click', () => { if (session) void refresh('fit'); else void launch(); });
checkIn.addEventListener('click', event => {
  if (telegram?.openTelegramLink) { event.preventDefault(); telegram.openTelegramLink(checkIn.href); }
});
telegram?.ready();
telegram?.expand();
if (telegram?.isVersionAtLeast?.('7.7')) telegram.disableVerticalSwipes?.();
telegram?.BackButton?.onClick(() => {
  const opened = dialogs.find(dialog => dialog.open);
  if (opened) opened.close();
  else setMine(false);
});
telegram?.onEvent('themeChanged', setTheme);
telegram?.onEvent('viewportChanged', sizeSheet);
preference.addEventListener('change', setTheme);
window.visualViewport?.addEventListener('resize', sizeSheet);
window.visualViewport?.addEventListener('scroll', sizeSheet);
sizeSheet();
setTheme();
void launch();
