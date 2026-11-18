import type { CurrentUser, Destination, LocationHistoryEntry, Place } from './models.js';

export type HistoricalPlace = Place & Pick<LocationHistoryEntry, 'user_id' | 'recorded_at'>;

export interface LocationRepository {
  initialize(): Promise<void>;
  getUser(userId: string): Promise<CurrentUser | null>;
  listUsers(): Promise<CurrentUser[]>;
  listHistory(userIds: ReadonlySet<string>): Promise<HistoricalPlace[]>;
  saveLocation(user: CurrentUser, event: LocationHistoryEntry): Promise<void>;
  saveDestination(userId: string, destination: Destination | null): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
