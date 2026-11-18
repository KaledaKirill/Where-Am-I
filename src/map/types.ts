export const mapModes = ['current', 'history', 'plans', 'mine'] as const;
export type MapMode = typeof mapModes[number];
export type MapPoint = [longitude: number, latitude: number];

export interface MapParticipant {
  id: string;
  name: string;
  username: string | null;
}

export interface MapPlace {
  id: string;
  label: string;
  level: 'city' | 'county' | 'state' | 'country';
  point: MapPoint | null;
}

export interface MapEvent {
  place: MapPlace;
  date: string | null;
  isLatest?: boolean;
}

export interface MapTraveler {
  id: string;
  current?: MapEvent;
  destination?: MapPlace;
  history?: MapEvent[];
}

export interface MapData {
  participants: MapParticipant[];
  travelers: MapTraveler[];
  resolvingPlaces: boolean;
}

export interface MapSession {
  token: string;
  viewerId: string;
  styleUrl: string;
  darkStyleUrl: string;
  checkInUrl?: string;
}
