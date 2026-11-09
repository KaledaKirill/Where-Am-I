import type { LocationRepository } from '../domain/location-repository.js';
import { LocationError } from '../domain/models.js';
import type { LocationGroup, CurrentUser, TelegramUser } from '../domain/models.js';

export function normalizeInput(input: string): string {
  const value = input.trim();
  if (!value) throw new LocationError('empty_input');
  const parts = value.includes(',') ? value.split(',').map((part) => part.trim()) : value.split(/\s+/u);
  // Validate the shape only; preserve spelling and multi-word names as entered.
  if ([...value].length > 120 || /[\p{Cc}]/u.test(value)
    || (value.includes(',') ? parts.length !== 2 : parts.length < 2)
    || parts.some((part) => !/\p{L}/u.test(part))) {
    throw new LocationError('invalid_input');
  }
  return value;
}

export class LocationService {
  constructor(
    private readonly repository: LocationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async setLocation(author: TelegramUser, input: string): Promise<CurrentUser> {
    const location = normalizeInput(input);
    try {
      const timestamp = this.now().toISOString();
      const user = { ...author, location, updated_at: timestamp };
      await this.repository.saveLocation(user, { location, user_id: author.user_id, recorded_at: timestamp });
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

  async listGroups(): Promise<LocationGroup[]> {
    let users: CurrentUser[];
    try { users = await this.repository.listUsers(); }
    catch (error) { throw new LocationError('unavailable', { cause: error }); }
    const collator = new Intl.Collator('ru');
    const grouped = new Map<string, CurrentUser[]>();
    for (const user of users) {
      const key = user.location.normalize('NFKC').replace(/\s*,\s*/gu, ' ').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
      const group = grouped.get(key) ?? [];
      group.push(user);
      grouped.set(key, group);
    }
    const groups = [...grouped].map(([key, people]) => {
      // Use the latest spelling for the shared heading.
      people.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.user_id.localeCompare(b.user_id));
      return { key, label: people[0]!.location, users: people };
    });
    for (const group of groups) group.users.sort((a, b) => collator.compare(a.display_name, b.display_name) || a.user_id.localeCompare(b.user_id));
    return groups.sort((a, b) => collator.compare(a.label, b.label) || a.key.localeCompare(b.key));
  }
}
