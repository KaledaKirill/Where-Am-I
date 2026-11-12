import type { CurrentUser, Destination, LocationHistoryEntry, PlaceCandidate } from '../src/domain/models.js';
import type { LocationRepository } from '../src/domain/location-repository.js';

export const author = { user_id: '1001', display_name: 'Анна', username: 'anna' };
export const coordinates = { latitude: 52.52, longitude: 13.405 };
export const place = { city: 'Берлин', region: 'Берлин', country: 'Германия', country_code: '', county: '' };
export const current: CurrentUser = { ...author, ...coordinates, ...place, destination: null, coordinate_source: 'telegram', location: 'Берлин, Германия', updated_at: '2026-11-09T12:00:00.000Z' };
export const event = { ...coordinates, ...place, coordinate_source: 'telegram' as const, location: current.location, user_id: current.user_id, recorded_at: current.updated_at };
export const candidate: PlaceCandidate = { ...place, ...coordinates, country_code: 'de', type: 'city', confidence: 1, exact: true };

export const env = {
  PUBLIC_BASE_URL: 'https://where-am-i.onrender.com',
  TELEGRAM_BOT_TOKEN: '123:fake_token', TELEGRAM_GROUP_ID: '-100123', TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  GOOGLE_SPREADSHEET_ID: 'sheet-id', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'bot@project.iam.gserviceaccount.com',
  GEOAPIFY_API_KEY: 'fake-geocoding-key',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
};

export class MemoryRepository implements LocationRepository {
  users = new Map<string, CurrentUser>();
  history: LocationHistoryEntry[] = [];
  settings = new Map<string, string>();
  async getSetting(key: string) { return this.settings.get(key) ?? null; }
  async setSetting(key: string, value: string) { this.settings.set(key, value); }
  async initialize() {}
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async listUsers() { return [...this.users.values()]; }
  async saveLocation(user: CurrentUser, event: LocationHistoryEntry) {
    this.users.set(user.user_id, { ...user, destination: this.users.get(user.user_id)?.destination ?? null });
    this.history.push(event);
  }
  async saveDestination(userId: string, destination: Destination | null) {
    const user = this.users.get(userId);
    if (!user) throw new Error('Current location required');
    this.users.set(userId, { ...user, destination });
  }
}
