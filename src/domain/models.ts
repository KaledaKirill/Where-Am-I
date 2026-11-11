export interface TelegramUser {
  user_id: string;
  display_name: string;
  username: string | null;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface Place {
  city: string;
  region: string;
  country: string;
}

export interface LocatedPlace extends Place, Coordinates {
  coordinate_source: 'telegram' | 'geocoded';
  location: string;
}

export interface CurrentUser extends TelegramUser, LocatedPlace {
  updated_at: string;
}

export interface LocationHistoryEntry extends LocatedPlace {
  user_id: string;
  recorded_at: string;
}

export interface LocationGroup {
  key: string;
  label: string;
  users: CurrentUser[];
}

export type LocationErrorCode = 'invalid_input' | 'geocoding_failed' | 'unavailable';

export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LocationError';
  }
}
