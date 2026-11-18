import { z } from 'zod';
import { validCoordinates } from '../domain/geocoder.js';
import type { HistoricalPlace, LocationRepository } from '../domain/location-repository.js';
import type { Coordinates, Place } from '../domain/models.js';
import { readMapDependency } from './dependencies.js';
import { countryCodes, describePlace } from './places.js';
import type { PlaceResolver } from './places.js';
import type { MapData, MapEvent, MapMode, MapPoint, MapTraveler } from './types.js';

const timestamp = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
function time(value: string): number | null {
  if (!timestamp.safeParse(value).success) return null;
  const valueOf = Date.parse(value);
  return Number.isFinite(valueOf) ? valueOf : null;
}

const names = new Intl.Collator('ru');

export class MapService {
  private readonly pendingMembers = new Map<number, Promise<boolean>>();

  constructor(private readonly repository: Pick<LocationRepository, 'listUsers' | 'listHistory'>,
    private readonly checkMember: (id: number) => Promise<boolean>, private readonly places: PlaceResolver) {}

  isMember(id: number): Promise<boolean> {
    const pending = this.pendingMembers.get(id);
    if (pending) return pending;
    const check = this.checkMember(id).finally(() => { this.pendingMembers.delete(id); });
    this.pendingMembers.set(id, check);
    return check;
  }

  async data(viewerId: number, mode: MapMode, selectedIds?: string[]): Promise<MapData> {
    const viewer = String(viewerId);
    const listed = await readMapDependency('users_sheet', () => this.repository.listUsers());
    const users = listed.filter(user => user.user_id === viewer);
    if (mode !== 'mine') {
      const others = listed.filter(user => user.user_id !== viewer);
      for (let start = 0; start < others.length; start += 8) {
        const batch = others.slice(start, start + 8);
        const active = await Promise.all(batch.map(user =>
          readMapDependency('participant_membership', () => this.isMember(Number(user.user_id)))));
        users.push(...batch.filter((_user, index) => active[index]));
      }
    }
    users.sort((a, b) => names.compare(a.display_name, b.display_name) || a.user_id.localeCompare(b.user_id));
    const participants = users.map(user => ({ id: user.user_id, name: user.display_name, username: user.username }));
    const selection = selectedIds ? new Set(selectedIds) : undefined;
    const selected = users.filter(user => mode === 'mine' || !selection || selection.has(user.user_id));
    const ids = new Set(mode === 'mine' ? [viewer] : selected.map(user => user.user_id));
    const history = mode === 'current' || !ids.size ? [] :
      (await readMapDependency('history_sheet', () => this.repository.listHistory(ids))).filter(row => ids.has(row.user_id));
    const destinations = mode === 'plans' ? selected.flatMap(user => user.destination ? [user.destination] : []) : [];
    const inputPlaces = [...selected, ...history, ...destinations];
    const codes = countryCodes(inputPlaces);
    const identity = (place: Place) => describePlace(place, codes);
    const known = new Map<string, MapPoint>();
    const remember = (place: Place, coordinates: Coordinates | undefined) => {
      const { id } = identity(place);
      if (coordinates && validCoordinates(coordinates) && !known.has(id)) known.set(id, [coordinates.longitude, coordinates.latitude]);
    };
    // Text check-ins and destinations already store representatives resolved by Geoapify.
    for (const user of selected) if (user.coordinate_source === 'geocoded') remember(user, user);
    for (const place of destinations) remember(place, place);
    for (const row of history) remember(row, row.geocodedPoint);
    const unresolved = inputPlaces.map(identity).filter(place => !known.has(place.id));
    const resolvingPlaces = await this.places.prepare(unresolved);
    const point = (place: Place) => {
      const normalized = identity(place);
      const saved = known.get(normalized.id);
      return saved ? { id: normalized.id, label: normalized.label, level: normalized.type, point: saved } : this.places.point(normalized);
    };
    const event = (place: Place, value: number | null, isLatest?: boolean): MapEvent => ({
      place: point(place), date: value === null ? null : new Date(value).toISOString().slice(0, 10),
      ...(isLatest ? { isLatest } : {}),
    });
    const historyByUser = new Map<string, { row: HistoricalPlace; instant: number | null }[]>();
    for (const row of history) {
      const existing = historyByUser.get(row.user_id) ?? [];
      existing.push({ row, instant: time(row.recorded_at) });
      historyByUser.set(row.user_id, existing);
    }
    const track = (id: string, latest: number | null, latestPlaceId?: string) => {
      const events = (historyByUser.get(id) ?? []).sort((a, b) => (a.instant ?? Infinity) - (b.instant ?? Infinity));
      return events.map(({ row, instant }) => event(row, instant,
        latest !== null && instant === latest && identity(row).id === latestPlaceId));
    };
    const travelers: MapTraveler[] = selected.map(user => {
      const instant = time(user.updated_at);
      const current = event(user, instant);
      return { id: user.user_id, current,
        ...(mode !== 'current' ? { history: track(user.user_id, instant, current.place.id) } : {}),
        ...(mode === 'plans' && user.destination ? { destination: point(user.destination) } : {}),
      };
    });
    if (mode === 'mine' && !travelers.length && history.length) {
      participants.push({ id: viewer, name: 'Вы', username: null });
      travelers.push({ id: viewer, history: track(viewer, null) });
    }
    return { participants, travelers, resolvingPlaces };
  }
}
