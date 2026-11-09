export interface TelegramUser {
  user_id: string;
  display_name: string;
  username: string | null;
}

export interface CurrentUser extends TelegramUser {
  location: string;
  updated_at: string;
}

export interface LocationHistoryEntry {
  user_id: string;
  location: string;
  recorded_at: string;
}

export interface LocationGroup {
  key: string;
  label: string;
  users: CurrentUser[];
}

export type LocationErrorCode = 'empty_input' | 'invalid_input' | 'unavailable';

export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LocationError';
  }
}
