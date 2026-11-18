import type { PlaceGroup } from './geometry.js';
import type { MapEvent, MapParticipant } from '../types.js';

export const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function append<T extends keyof HTMLElementTagNameMap>(parent: Node, tag: T, className = '', text?: string): HTMLElementTagNameMap[T] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
export function participantSearch(people: MapParticipant[], query: string): MapParticipant[] {
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  return people.filter(person => {
    const target = normalize(`${person.name} ${person.username ? `@${person.username}` : ''}`);
    return terms.every(term => target.includes(term));
  });
}

function personText(row: HTMLElement, person: MapParticipant, color: string, subtitle?: string) {
  const icon = append(row, 'span', 'avatar', Array.from(person.name.trim())[0]?.toLocaleUpperCase('ru') ?? '•');
  icon.setAttribute('aria-hidden', 'true');
  icon.style.setProperty('--person-color', color);
  const text = append(row, 'span', 'row-text');
  append(text, 'strong', '', person.name);
  if (subtitle) append(text, 'small', '', subtitle);
}

const formatter = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeZone: 'UTC' });
export function eventDate(date: string | null, relative = false): string {
  if (!date) return 'Дата неизвестна';
  const time = new Date(`${date}T00:00:00Z`);
  if (relative) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
    if (date === today) return 'Сегодня';
    if (date === yesterday) return 'Вчера';
  }
  return formatter.format(time);
}

export class ParticipantPanel {
  private readonly panel = element<HTMLDialogElement>('filter-sheet');
  private readonly search = element<HTMLInputElement>('search');
  private readonly list = element<HTMLUListElement>('person-list');
  private readonly apply = element<HTMLButtonElement>('apply');
  private readonly clear = element<HTMLButtonElement>('clear');
  private readonly selectAll = element<HTMLButtonElement>('select-all');
  private people: MapParticipant[] = [];
  private results: MapParticipant[] = [];
  private draft = new Set<string>();
  private shown = 0;
  constructor(private readonly onOpen: (dialog: HTMLDialogElement) => void,
    private readonly colorFor: (id: string) => string, onApply: (ids: Set<string> | null) => void) {
    this.search.addEventListener('input', () => this.render());
    this.clear.addEventListener('click', () => this.bulk(false));
    this.selectAll.addEventListener('click', () => this.bulk(true));
    this.apply.addEventListener('click', () => {
      this.panel.close();
      onApply(this.draft.size === this.people.length ? null : new Set(this.draft));
    });
    this.list.addEventListener('scroll', () => {
      const { scrollHeight, clientHeight, scrollTop } = this.list;
      if (this.shown < this.results.length && scrollHeight - clientHeight - scrollTop < 150) this.appendRows();
    }, { passive: true });
  }

  open(people: MapParticipant[], selection: Set<string> | null) {
    this.people = people;
    this.draft = new Set(people.filter(person => !selection || selection.has(person.id)).map(person => person.id));
    this.search.value = '';
    this.render();
    this.onOpen(this.panel);
  }

  private render() {
    this.results = participantSearch(this.people, this.search.value);
    this.shown = 0;
    this.list.replaceChildren();
    const searching = !!this.search.value.trim();
    this.clear.textContent = searching ? 'Снять найденных' : 'Снять выбор';
    this.selectAll.textContent = searching ? 'Выбрать найденных' : 'Выбрать всех';
    if (this.results.length) this.appendRows();
    else append(this.list, 'li', 'message', searching ? 'По запросу никого не нашли' : 'Участники пока не отметились');
    this.list.scrollTop = 0;
    this.updateButtons();
  }

  private appendRows() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(this.results.length, this.shown + 40);
    for (const person of this.results.slice(this.shown, end)) {
      const label = append(append(fragment, 'li'), 'label', 'row');
      personText(label, person, this.colorFor(person.id), person.username ? `@${person.username}` : undefined);
      const input = append(label, 'input');
      input.type = 'checkbox';
      input.value = person.id;
      input.checked = this.draft.has(person.id);
      input.addEventListener('change', () => {
        if (input.checked) this.draft.add(person.id);
        else this.draft.delete(person.id);
        this.updateButtons();
      });
    }
    this.list.append(fragment);
    this.shown = end;
  }

  private bulk(selected: boolean) {
    for (const person of this.results) {
      if (selected) this.draft.add(person.id);
      else this.draft.delete(person.id);
    }
    this.list.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = this.draft.has(input.value); });
    this.updateButtons();
  }

  private updateButtons() {
    this.clear.disabled = this.results.every(person => !this.draft.has(person.id));
    this.selectAll.disabled = this.results.every(person => this.draft.has(person.id));
    this.apply.textContent = this.draft.size ? `Показать на карте · ${this.draft.size}` : 'Скрыть всех на карте';
  }
}

const levels = { city: 'Населённый пункт', county: 'Район', state: 'Регион', country: 'Страна' };
export class DetailPanel {
  private readonly title = element('detail-title');
  private readonly detail = element('detail-body');
  private readonly dialog = element<HTMLDialogElement>('detail-sheet');

  constructor(private readonly onOpen: (dialog: HTMLDialogElement) => void,
    private readonly colorFor: (id: string) => string) {}

  place(group: PlaceGroup, people: MapParticipant[]) {
    const { title, detail } = this;
    title.textContent = group.place.label;
    detail.replaceChildren();
    append(detail, 'p', 'message', levels[group.place.level]);
    const byId = new Map(people.map(person => [person.id, person]));
    const sections = [
      { name: 'Последние отметки', members: [...group.current].map(([id, value]) => [id, eventDate(value.date, true)] as const) },
      { name: 'Раньше отмечались', members: [...group.history].map(([id, values]) =>
        [id, values.filter(value => value.date).map(value => eventDate(value.date)).reverse().slice(0, 3).join(' · ') || 'Дата неизвестна'] as const) },
      { name: 'Планируют приехать', members: [...group.plans].map(id => [id, undefined] as const) },
    ];
    for (const { name, members } of sections) {
      if (!members.length) continue;
      append(detail, 'h3', '', `${name} · ${members.length}`);
      for (const [id, subtitle] of members) {
        const person = byId.get(id);
        if (person) personText(append(detail, 'div', 'row'), person, this.colorFor(id), subtitle);
      }
    }
    this.open();
  }

  places(groups: PlaceGroup[], openPlace: (id: string) => void) {
    const { title, detail } = this;
    title.textContent = 'Места';
    detail.replaceChildren();
    const sorted = [...groups].sort((a, b) => a.place.label.localeCompare(b.place.label, 'ru'));
    for (const { place, current, history, plans } of sorted) {
      const row = append(detail, 'button', 'row row-button');
      row.type = 'button';
      const text = append(row, 'span', 'row-text');
      append(text, 'strong', '', place.label);
      append(text, 'small', '', [
        current.size && `Отметки ${current.size}`, history.size && `История ${history.size}`, plans.size && `Планы ${plans.size}`,
      ].filter(Boolean).join(' · '));
      row.addEventListener('click', () => openPlace(place.id));
    }
    if (!sorted.length) append(detail, 'p', 'message', 'Здесь пока нет мест');
    this.open();
  }

  timeline(events: MapEvent[], focus: (event: MapEvent) => void) {
    const { title, detail, dialog } = this;
    title.textContent = 'Мои отметки';
    detail.replaceChildren();
    const ordered = [...events.filter(event => event.date).reverse(), ...events.filter(event => !event.date)];
    for (const event of ordered) {
      const row = append(detail, event.place.point ? 'button' : 'div', event.place.point ? 'row row-button' : 'row');
      const text = append(row, 'span', 'row-text');
      append(text, 'strong', '', event.place.label);
      append(text, 'small', '', eventDate(event.date));
      if (row instanceof HTMLButtonElement) {
        row.type = 'button';
        row.addEventListener('click', () => { dialog.close(); focus(event); });
      }
    }
    if (!ordered.length) append(detail, 'p', 'message', 'Здесь пока нет отметок');
    this.open();
  }

  private open() {
    this.onOpen(this.dialog);
    this.detail.scrollTop = 0;
  }
}
