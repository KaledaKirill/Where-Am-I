import type { LocationRepository } from '../domain/location-repository.js';
import type { Geocoder } from '../domain/geocoder.js';
import { locationLabel, validCoordinates } from '../domain/geocoder.js';
import { LocationError } from '../domain/models.js';
import type { Coordinates, LocationGroup, CurrentUser, TelegramUser } from '../domain/models.js';

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
    try {
      const timestamp = this.now().toISOString();
      const location = { ...place, ...coordinates, location: locationLabel(place), coordinate_source: 'telegram' as const };
      const user = { ...author, ...location, updated_at: timestamp };
      await this.repository.saveLocation(user, { ...location, user_id: author.user_id, recorded_at: timestamp });
      return user;
    } catch (error) { throw new LocationError('unavailable', { cause: error }); }
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
