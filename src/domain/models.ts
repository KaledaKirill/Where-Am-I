export interface ResolvedPlace {
  place_key: string;
  city: string;
  region: string | null;
  country: string;
  country_code: string;
  latitude: number;
  longitude: number;
}

export interface TelegramUser {
  user_id: string;
  display_name: string;
  username: string | null;
}

export interface CurrentUser extends TelegramUser, ResolvedPlace {
  updated_at: string;
}

export interface LocationHistoryEntry extends ResolvedPlace {
  user_id: string;
  recorded_at: string;
}

export interface CityGroup {
  place_key: string;
  label: string;
  users: CurrentUser[];
}

export type LocationErrorCode = 'empty_input' | 'invalid_input' | 'not_found' | 'ambiguous' | 'unavailable';

export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LocationError';
  }
}
