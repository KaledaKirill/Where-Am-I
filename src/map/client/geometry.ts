import type { Feature, FeatureCollection, MultiLineString, Point } from 'geojson';
import type { MapData, MapEvent, MapPlace, MapPoint } from '../types.js';

export interface PlaceGroup {
  place: MapPlace;
  current: Map<string, MapEvent>;
  history: Map<string, MapEvent[]>;
  plans: Set<string>;
}

export function lineSegments(from: MapPoint, to: MapPoint): MapPoint[][] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  const change = to[0] - from[0];
  if (Math.abs(change) <= 180) return [[from, to]];
  const edge = change > 0 ? -180 : 180;
  const shifted = to[0] + (change > 0 ? -360 : 360);
  if (shifted === from[0]) return [[from, [from[0], to[1]]]];
  const latitude = from[1] + (to[1] - from[1]) * ((edge - from[0]) / (shifted - from[0]));
  return [
    ...(edge === from[0] ? [] : [[from, [edge, latitude] as MapPoint]]),
    ...(-edge === to[0] ? [] : [[[-edge, latitude] as MapPoint, to]]),
  ];
}

export function historySegments(events: MapEvent[]): MapPoint[][] {
  const lines: MapPoint[][] = [];
  let previous: MapPoint | null = null;
  for (const event of events) {
    const current = event.date ? event.place.point : null;
    if (previous && current) lines.push(...lineSegments(previous, current));
    previous = current;
  }
  return lines;
}

export function mapBounds(points: MapPoint[]): [MapPoint, MapPoint] | null {
  if (!points.length) return null;
  const longitudes = points.map(point => point[0]).sort((a, b) => a - b);
  let largestGap = -1;
  let start = 0;
  for (const [index, value] of longitudes.entries()) {
    const next = longitudes[index + 1] ?? longitudes[0]! + 360;
    if (next - value > largestGap) {
      largestGap = next - value;
      start = (index + 1) % longitudes.length;
    }
  }
  const west = longitudes[start]!;
  let south = Infinity;
  let north = -Infinity;
  for (const point of points) {
    south = Math.min(south, point[1]);
    north = Math.max(north, point[1]);
  }
  return [[west, south], [west + 360 - largestGap, north]];
}

export interface Scene {
  groups: Map<string, PlaceGroup>;
  markers: FeatureCollection<Point>;
  routes: FeatureCollection<MultiLineString>;
}

export function scene(travelers: MapData['travelers'], dark: boolean, colorFor: (id: string) => string): Scene {
  const groups = new Map<string, PlaceGroup>();
  const routes: Feature<MultiLineString>[] = [];
  function group(place: MapPlace): PlaceGroup {
    const existing = groups.get(place.id);
    if (existing) return existing;
    const value: PlaceGroup = { place, current: new Map(), history: new Map(), plans: new Set() };
    groups.set(place.id, value);
    return value;
  }
  for (const traveler of travelers) {
    const { id, current, destination, history = [] } = traveler;
    if (current) group(current.place).current.set(id, current);
    for (const event of history) {
      if (event.isLatest) continue;
      const { history: visits } = group(event.place);
      const previous = visits.get(id) ?? [];
      previous.push(event);
      visits.set(id, previous);
    }
    if (destination) group(destination).plans.add(id);
    const plans = current?.place.point && destination?.point ? lineSegments(current.place.point, destination.point) : [];
    for (const [kind, coordinates] of [['history', historySegments(history)], ['plan', plans]] as const) {
      if (coordinates.length) routes.push({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates },
        properties: { color: colorFor(id), kind } });
    }
  }
  const markers: Feature<Point>[] = [];
  for (const { place, current, history, plans } of groups.values()) {
    if (!place.point) continue;
    const kind = current.size ? 'current' : plans.size ? 'plan' : 'history';
    const size = current.size || plans.size || history.size;
    const id = (current.keys().next().value ?? plans.values().next().value) as string | undefined;
    markers.push({ type: 'Feature', geometry: { type: 'Point', coordinates: place.point }, properties: {
      placeId: place.id, label: place.label.split(',')[0], kind, size,
      planBadge: kind === 'current' && plans.size ? `↗ ${plans.size}` : '',
      color: id && size === 1 ? colorFor(id) : dark ? '#91baff' : '#285bcd',
    } });
  }
  return { groups, markers: { type: 'FeatureCollection', features: markers }, routes: { type: 'FeatureCollection', features: routes } };
}
