import type { CurrentUser, LocationHistoryEntry } from './models.js';

export interface LocationRepository {
  initialize(): Promise<void>;
  getUser(userId: string): Promise<CurrentUser | null>;
  listUsers(): Promise<CurrentUser[]>;
  saveLocation(user: CurrentUser, event: LocationHistoryEntry): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
