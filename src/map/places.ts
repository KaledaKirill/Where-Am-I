import { locationLabel, normalizePlace, validCoordinates } from '../domain/geocoder.js';
import type { Place, PlaceCandidate, PlaceType } from '../domain/models.js';
import type { MapPlace, MapPoint } from './types.js';

type MapPlaceLookup = (query: string, type: PlaceType, countryCode?: string) => Promise<PlaceCandidate[]>;

export interface PlaceIdentity {
  id: string;
  label: string;
  type: PlaceType;
  name: string;
  region: string;
  country: string;
  countryCode?: string;
}

export function countryCodes(places: Place[]): Map<string, string> {
  const codes = new Map<string, Set<string>>();
  for (const place of places) {
    if (!place.country_code) continue;
    const name = normalizePlace(place.country);
    const known = codes.get(name) ?? new Set<string>();
    known.add(place.country_code);
    codes.set(name, known);
  }
  return new Map([...codes].flatMap(([name, known]) => known.size === 1 ? [[name, [...known][0]!]] : []));
}

export function describePlace(place: Place, codes: Map<string, string>): PlaceIdentity {
  const countryCode = place.country_code || codes.get(normalizePlace(place.country));
  const type = place.city ? 'city' : place.county ? 'county' : place.region ? 'state' : 'country';
  const name = place.city || place.county || place.region || place.country;
  const region = (type === 'city' || type === 'county') && normalizePlace(place.region) !== normalizePlace(name) ? place.region : '';
  const label = locationLabel(place);
  const id = JSON.stringify([type, countryCode || normalizePlace(place.country), normalizePlace(region), normalizePlace(name)]);
  return { id, label, type, name, region, country: place.country, countryCode };
}

export class PlaceResolver {
  private readonly cache = new Map<string, { point: MapPoint | null; expires: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly lookup: MapPlaceLookup) {}

  async prepare(places: PlaceIdentity[]): Promise<boolean> {
    const jobs = [...new Map(places.map(place => [place.id, place])).values()].flatMap(place => {
      if ((this.cache.get(place.id)?.expires ?? 0) > Date.now()) return [];
      const existing = this.pending.get(place.id);
      if (existing) return [existing];
      const job = this.load(place).finally(() => { this.pending.delete(place.id); });
      this.pending.set(place.id, job);
      return [job];
    });
    if (!jobs.length) return false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all(jobs).then(() => false),
        new Promise<true>(resolve => { deadline = setTimeout(() => resolve(true), 1_800).unref(); }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  point(place: PlaceIdentity): MapPlace {
    const cached = this.cache.get(place.id);
    return { id: place.id, label: place.label, level: place.type, point: cached && cached.expires > Date.now() ? cached.point : null };
  }

  private async load(place: PlaceIdentity): Promise<void> {
    if (this.active < 4) this.active++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    let point: MapPoint | null = null;
    try {
      const query = [place.name, place.region, place.type !== 'country' ? place.country : ''].filter(Boolean).join(', ');
      const equals = (first: string, second: string) => normalizePlace(first) === normalizePlace(second);
      const matches = (candidate: PlaceCandidate) => {
        const name = candidate.city || candidate.county || candidate.region || candidate.country;
        const candidateRegion = equals(name, candidate.region) ? '' : candidate.region;
        return candidate.type === place.type && equals(name, place.name) && validCoordinates(candidate)
          && (place.countryCode ? candidate.country_code === place.countryCode : equals(candidate.country, place.country))
          && (!place.region || equals(place.region, candidateRegion));
      };
      let candidates = (await this.lookup(query, place.type, place.countryCode)).filter(matches);
      if (!candidates.length && query !== place.name) {
        candidates = (await this.lookup(place.name, place.type, place.countryCode)).filter(matches);
      }
      const [first] = candidates;
      if (first && candidates.every(candidate => equals(candidate.region, first.region)
        && Math.abs(candidate.longitude - first.longitude) < 0.05 && Math.abs(candidate.latitude - first.latitude) < 0.05)) {
        point = [first.longitude, first.latitude];
      }
    } catch { /* Keep the place label available during provider outages. */ }
    finally {
      this.cache.delete(place.id);
      this.cache.set(place.id, { point, expires: Date.now() + (point ? 7 * 86_400_000 : 60_000) });
      if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value!);
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
