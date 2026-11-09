import type { CurrentUser, LocationHistoryEntry } from '../src/domain/models.js';
import type { LocationRepository } from '../src/domain/location-repository.js';

export const author = { user_id: '1001', display_name: 'Анна', username: 'anna' };
export const current: CurrentUser = { ...author, location: 'Берлин, Германия', updated_at: '2026-11-09T12:00:00.000Z' };

export const env = {
  PUBLIC_BASE_URL: 'https://where-am-i.onrender.com',
  TELEGRAM_BOT_TOKEN: '123:fake_token', TELEGRAM_GROUP_ID: '-100123', TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  GOOGLE_SPREADSHEET_ID: 'sheet-id', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'bot@project.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
};

export class MemoryRepository implements LocationRepository {
  users = new Map<string, CurrentUser>();
  history: LocationHistoryEntry[] = [];
  async initialize() {}
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async listUsers() { return [...this.users.values()]; }
  async saveLocation(user: CurrentUser, event: LocationHistoryEntry) {
    this.users.set(user.user_id, user);
    this.history.push(event);
  }
}
