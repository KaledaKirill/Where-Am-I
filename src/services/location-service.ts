import type { LocationRepository } from '../domain/location-repository.js';
import type { Geocoder } from '../domain/geocoder.js';
import { locationLabel, normalizePlace, validCoordinates } from '../domain/geocoder.js';
import { LocationError } from '../domain/models.js';
import type { Coordinates, Destination, LocatedPlace, LocationGroup, CurrentUser, PlaceCandidate, TelegramUser, TravelerSearchResult } from '../domain/models.js';

export class LocationService {
  constructor(
    private readonly repository: LocationRepository,
    private readonly geocoder: Geocoder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async setLocation(author: TelegramUser, coordinates: Coordinates): Promise<CurrentUser> {
    if (!validCoordinates(coordinates)) throw new LocationError('invalid_input');
    let place;
    try {
      place = await this.geocoder.reverse(coordinates);
      if (!place.country.trim()) throw new Error('Missing country');
    } catch (error) { throw new LocationError('geocoding_failed', { cause: error }); }
    return this.saveLocation(author, { ...place, ...coordinates, location: locationLabel(place), coordinate_source: 'telegram' });
  }

  async resolveText(query: string, settlementsOnly: boolean): Promise<PlaceCandidate[]> {
    const text = query.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (text.length < 2 || text.length > 200 || !/^[\p{L}\p{M}\p{N}\s,.'’-]+$/u.test(text) || !/\p{L}/u.test(text)) {
      throw new LocationError('invalid_input');
    }
    let candidates: PlaceCandidate[];
    try {
      if (!this.geocoder.search) throw new Error('Search geocoder unavailable');
      candidates = await this.geocoder.search(text, settlementsOnly);
    } catch (error) { throw new LocationError('geocoding_failed', { cause: error }); }
    if (!candidates.length) throw new LocationError('not_found');
    return candidates;
  }

  async setTextLocation(author: TelegramUser, candidate: PlaceCandidate): Promise<CurrentUser> {
    const place = this.destination(candidate);
    return this.saveLocation(author, { ...place, location: locationLabel(place), coordinate_source: 'geocoded' });
  }

  private destination(candidate: PlaceCandidate): Destination {
    if (candidate.type !== 'city' || !candidate.city || !candidate.country || !candidate.country_code || !validCoordinates(candidate)) {
      throw new LocationError('invalid_input');
    }
    return { city: candidate.city, region: candidate.region, county: candidate.county || '', country: candidate.country,
      country_code: candidate.country_code, latitude: candidate.latitude, longitude: candidate.longitude };
  }

  private async saveLocation(author: TelegramUser, location: LocatedPlace): Promise<CurrentUser> {
    try {
      const timestamp = this.now().toISOString();
      const previous = await this.repository.getUser(author.user_id);
      const user: CurrentUser = { ...author, ...location, destination: previous?.destination ?? null, updated_at: timestamp };
      await this.repository.saveLocation(user, { ...location, user_id: author.user_id, recorded_at: timestamp });
      return user;
    } catch (error) { throw new LocationError('unavailable', { cause: error }); }
  }

  async hasLocation(userId: string): Promise<boolean> {
    try { return !!await this.repository.getUser(userId); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
  }

  async setDestination(userId: string, candidate: PlaceCandidate | null): Promise<void> {
    const destination = candidate ? this.destination(candidate) : null;
    if (!await this.hasLocation(userId)) throw new LocationError('no_location');
    try { await this.repository.saveDestination(userId, destination); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
  }

  async findTravelers(query: PlaceCandidate): Promise<TravelerSearchResult> {
    let users: CurrentUser[];
    try { users = await this.repository.listUsers(); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
    const equal = (a: string | undefined, b: string | undefined) => !!a && !!b && normalizePlace(a) === normalizePlace(b);
    const matches = (place: Destination) => {
      if (!(place.country_code && query.country_code ? equal(place.country_code, query.country_code) : equal(place.country, query.country))) return false;
      if (query.type === 'country') return true;
      if (query.type === 'state') return equal(place.region, query.region);
      if (query.type === 'county') return equal(place.county, query.county) && (!query.region || equal(place.region, query.region));
      return equal(place.city, query.city) && normalizePlace(place.region) === normalizePlace(query.region);
    };
    const collator = new Intl.Collator('ru');
    users.sort((a, b) => collator.compare(a.display_name, b.display_name) || a.user_id.localeCompare(b.user_id));
    return { current: users.filter(matches), planned: users.filter((user) => user.destination && matches(user.destination)) };
  }

  async listGroups(): Promise<LocationGroup[]> {
    let users: CurrentUser[];
    try { users = await this.repository.listUsers(); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
    const collator = new Intl.Collator('ru');
    const grouped = new Map<string, CurrentUser[]>();
    for (const user of users) {
      const key = JSON.stringify([user.country, user.region, user.city].map((s) => s.normalize('NFKC').trim().toLocaleLowerCase('ru')));
      const group = grouped.get(key) ?? [];
      group.push(user);
      grouped.set(key, group);
    }
    const groups = [...grouped].map(([key, people]) => {
      people.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.user_id.localeCompare(b.user_id));
      return { key, label: locationLabel(people[0]!), users: people };
    });
    for (const group of groups) group.users.sort((a, b) => collator.compare(a.display_name, b.display_name) || a.user_id.localeCompare(b.user_id));
    return groups.sort((a, b) => collator.compare(a.label, b.label) || a.key.localeCompare(b.key));
  }
}
