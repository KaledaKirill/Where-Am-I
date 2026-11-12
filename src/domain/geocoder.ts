import type { Coordinates, Place, PlaceCandidate } from './models.js';

export interface Geocoder {
  reverse(coordinates: Coordinates): Promise<Place>;
  search?(query: string, settlementsOnly: boolean): Promise<PlaceCandidate[]>;
}

export function normalizePlace(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/[,\s]+/gu, ' ').trim();
}

export interface ForwardGeocoder {
  forward(query: string): Promise<Place & Coordinates>;
}

export function locationLabel(place: Place): string {
  return [place.city || place.region, place.country].filter(Boolean).join(', ');
}

export function validCoordinates(value: Coordinates): boolean {
  return Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}
