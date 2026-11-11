import type { Coordinates, Place } from './models.js';

export interface Geocoder {
  reverse(coordinates: Coordinates): Promise<Place>;
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
