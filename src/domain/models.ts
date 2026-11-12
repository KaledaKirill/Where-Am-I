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
  country_code?: string;
  county?: string;
}

export type Destination = Place & Coordinates;
export type PlaceType = 'city' | 'state' | 'county' | 'country';
export interface PlaceCandidate extends Destination {
  type: PlaceType;
  confidence: number;
  exact: boolean;
}

export interface TravelerSearchResult {
  current: CurrentUser[];
  planned: CurrentUser[];
}

export interface LocatedPlace extends Place, Coordinates {
  coordinate_source: 'telegram' | 'geocoded';
  location: string;
}

export interface CurrentUser extends TelegramUser, LocatedPlace {
  updated_at: string;
  destination?: Destination | null;
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

export type LocationErrorCode = 'invalid_input' | 'geocoding_failed' | 'unavailable' | 'not_found' | 'no_location';

export class LocationError extends Error {
  constructor(public readonly code: LocationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = 'LocationError';
  }
}
