import type { LocationRepository } from '../domain/location-repository.js';
import type { PlaceResolver } from '../domain/place-resolver.js';
import { LocationError } from '../domain/models.js';
import type { CityGroup, CurrentUser, TelegramUser } from '../domain/models.js';

export function normalizeInput(input: string): string {
  const value = input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!value) throw new LocationError('empty_input');
  // Settlements do not require digits, URLs, street numbers, or coordinate notation.
  if ([...value].length > 120 || !/\p{L}/u.test(value)
    || /[\d@/:=<>\\\p{Cc}]|www\.|https?\b/iu.test(value)
    || /(?:^|[\s,])(?:ул\.?|улица|проспект|переулок|шоссе|street|road|avenue|str\.|straße)(?:[\s,]|$)/iu.test(value)) {
    throw new LocationError('invalid_input');
  }
  return value;
}

export class LocationService {
  constructor(
    private readonly repository: LocationRepository,
    private readonly resolver: PlaceResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async setLocation(author: TelegramUser, input: string): Promise<CurrentUser> {
    const query = normalizeInput(input);
    try {
      const places = [...new Map((await this.resolver.resolve(query)).map((place) => [place.place_key, place])).values()];
      if (!places.length) throw new LocationError('not_found');
      if (places.length !== 1) throw new LocationError('ambiguous');
      const place = places[0]!;
      const timestamp = this.now().toISOString();
      const user = { ...author, ...place, updated_at: timestamp };
      await this.repository.saveLocation(user, { ...place, user_id: author.user_id, recorded_at: timestamp });
      return user;
    } catch (error) {
      if (error instanceof LocationError) throw error;
      throw new LocationError('unavailable', { cause: error });
    }
  }

  async getMe(userId: string): Promise<CurrentUser | null> {
    try { return await this.repository.getUser(userId); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
  }

  async listGroups(): Promise<CityGroup[]> {
    let users: CurrentUser[];
    try { users = await this.repository.listUsers(); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
    const collator = new Intl.Collator('ru');
    const grouped = new Map<string, CurrentUser[]>();
    for (const user of users) {
      const group = grouped.get(user.place_key) ?? [];
      group.push(user);
      grouped.set(user.place_key, group);
    }
    const groups = [...grouped].map(([place_key, people]) => {
      // Latest snapshot supplies a consistent label when translations change.
      people.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.user_id.localeCompare(b.user_id));
      return { place_key, place: people[0]!, users: people };
    });
    return groups.map(({ place_key, place, users }) => {
      const ambiguous = groups.some((other) => other.place_key !== place_key
        && collator.compare(other.place.city, place.city) === 0
        && collator.compare(other.place.country, place.country) === 0);
      const label = [place.city, ...(ambiguous && place.region ? [place.region] : []), place.country].join(', ');
      return { place_key, label, users: users.sort((a, b) => collator.compare(a.display_name, b.display_name) || a.user_id.localeCompare(b.user_id)) };
    }).sort((a, b) => collator.compare(a.label, b.label) || a.place_key.localeCompare(b.place_key));
  }
}
