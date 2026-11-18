import { AttributionControl, Map as LibreMap } from 'maplibre-gl';
import type { CameraOptions, GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import { mapBounds } from './geometry.js';
import type { Scene } from './geometry.js';
import type { MapPoint } from '../types.js';

const baseStyle = (dark: boolean): StyleSpecification => ({
  version: 8, sources: {}, layers: [{ id: 'base', type: 'background', paint: { 'background-color': dark ? '#23334a' : '#e0ebf8' } }],
});
const unclustered: ['!', ['has', string]] = ['!', ['has', 'point_count']];
const dataLayer = 'wai-locations';
const clusterLayer = 'wai-clusters';

export class TravelMap {
  private readonly map: LibreMap;
  private scene?: Scene;
  private dark: boolean;
  private showingFallback = false;

  constructor(container: HTMLElement, style: string, dark: boolean,
    onPlace: (ids: string[]) => void, onBaseMapUnavailable: (unavailable: boolean) => void) {
    this.dark = dark;
    this.map = new LibreMap({ container, style, center: [0, 18], zoom: 1.15, maxZoom: 17,
      dragRotate: false, touchPitch: false, pitchWithRotate: false, attributionControl: false });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    this.map.on('style.load', () => { this.installLayers(); onBaseMapUnavailable(this.showingFallback); });
    this.map.on('error', () => {
      if (this.map.isStyleLoaded() || this.map.getLayer(dataLayer) || this.showingFallback) return;
      this.showingFallback = true;
      this.map.setStyle(baseStyle(this.dark), { diff: false });
      onBaseMapUnavailable(true);
    });
    this.map.on('click', event => {
      if (!this.map.getLayer(dataLayer)) return;
      const { x, y } = event.point;
      const hits = this.map.queryRenderedFeatures([[x - 9, y - 9], [x + 9, y + 9]], { layers: [dataLayer, clusterLayer] });
      const places = [...new Set(hits.map(hit => hit.properties.placeId).filter((id): id is string => typeof id === 'string'))];
      if (places.length) { onPlace(places); return; }
      const cluster = hits.find(hit => hit.geometry.type === 'Point' && typeof hit.properties.cluster_id === 'number');
      const source = this.map.getSource<GeoJSONSource>('wai-places');
      if (!source || !cluster || cluster.geometry.type !== 'Point') return;
      const [lng, lat] = cluster.geometry.coordinates;
      if (lng === undefined || lat === undefined) return;
      const adjusted = lng + 360 * Math.round((event.lngLat.lng - lng) / 360);
      void source.getClusterExpansionZoom(Number(cluster.properties.cluster_id))
        .then(zoom => this.map.easeTo({ zoom, center: [adjusted, lat], duration: 360 })).catch(() => {});
    });
    this.map.on('mousemove', event => {
      if (!this.map.getLayer(dataLayer)) return;
      const interactive = this.map.queryRenderedFeatures(event.point, { layers: [dataLayer, clusterLayer] }).length > 0;
      this.map.getCanvas().style.cursor = interactive ? 'pointer' : '';
    });
    new ResizeObserver(() => this.map.resize()).observe(container);
  }

  theme(style: string, dark: boolean) {
    if (this.dark === dark && !this.showingFallback) return;
    this.dark = dark;
    this.showingFallback = false;
    this.map.setStyle(style, { diff: false });
  }

  render(value: Scene) {
    this.scene = value;
    this.map.getSource<GeoJSONSource>('wai-places')?.setData(value.markers);
    this.map.getSource<GeoJSONSource>('wai-routes')?.setData(value.routes);
  }

  zoom(change: number) { this.map.easeTo({ zoom: this.map.getZoom() + change, duration: 230 }); }
  camera(): CameraOptions { return { center: this.map.getCenter(), zoom: this.map.getZoom() }; }
  restore(camera: CameraOptions) { this.map.jumpTo(camera); }
  fit(points: MapPoint[]) {
    const bounds = mapBounds(points);
    if (!bounds) { this.map.easeTo({ center: [0, 18], zoom: 1.15, duration: 360 }); return; }
    this.map.fitBounds(bounds, { maxZoom: 9, padding: { top: 42, bottom: 72, left: 34, right: 60 }, duration: 360 });
  }

  private installLayers() {
    const empty = { type: 'FeatureCollection', features: [] } as const;
    this.map.addSource('wai-routes', { type: 'geojson', data: this.scene?.routes ?? { ...empty, features: [] } });
    this.map.addLayer({ id: 'wai-history', type: 'line', source: 'wai-routes', filter: ['==', ['get', 'kind'], 'history'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.6, 'line-opacity': .85 } });
    this.map.addLayer({ id: 'wai-plans', type: 'line', source: 'wai-routes', filter: ['==', ['get', 'kind'], 'plan'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.6, 'line-dasharray': [2, 2.5], 'line-opacity': .9 } });
    this.map.addSource('wai-places', { type: 'geojson', data: this.scene?.markers ?? { ...empty, features: [] }, cluster: true, clusterMaxZoom: 10, clusterRadius: 44 });

    const surface = this.dark ? '#1e2f43' : '#fff';
    const color = this.dark ? '#91baff' : '#285bcd';
    const text = this.dark ? '#e5efff' : '#18304f';
    const textStyle = { 'text-color': text, 'text-halo-color': surface, 'text-halo-width': 1.5 } as const;
    const styleFont = this.map.getStyle().layers
      .flatMap(layer => layer.type === 'symbol' && Array.isArray(layer.layout?.['text-font']) ? [layer.layout['text-font']] : [])
      .find(font => font.every(item => typeof item === 'string')) as string[] | undefined;
    const font = styleFont ? { 'text-font': styleFont } : {};
    this.map.addLayer({ id: clusterLayer, type: 'circle', source: 'wai-places', filter: ['has', 'point_count'],
      paint: { 'circle-color': surface, 'circle-stroke-color': color, 'circle-stroke-width': 2, 'circle-radius': 16 } });
    this.map.addLayer({ id: 'wai-cluster-count', type: 'symbol', source: 'wai-places', filter: ['has', 'point_count'],
      layout: { ...font, 'text-field': ['to-string', ['get', 'point_count']], 'text-size': 13, 'text-allow-overlap': true }, paint: textStyle });
    this.map.addLayer({ id: dataLayer, type: 'circle', source: 'wai-places', filter: [...unclustered],
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'history', 7, 13],
        'circle-color': ['case', ['==', ['get', 'kind'], 'current'], ['get', 'color'], surface],
        'circle-stroke-width': 2,
        'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'current'], surface, color],
      } });
    this.map.addLayer({ id: 'wai-place-count', type: 'symbol', source: 'wai-places',
      filter: ['all', [...unclustered], ['!=', ['get', 'kind'], 'history']],
      layout: { ...font, 'text-field': ['to-string', ['get', 'size']], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': ['case', ['==', ['get', 'kind'], 'current'], this.dark ? '#142238' : '#ffffff', text] } });
    this.map.addLayer({ id: 'wai-place-name', type: 'symbol', source: 'wai-places', filter: [...unclustered],
      layout: { ...font, 'text-field': ['get', 'label'], 'text-size': 12, 'text-anchor': 'bottom', 'text-offset': [0, -1.25] }, paint: textStyle });
    this.map.addLayer({ id: 'wai-plan-count', type: 'symbol', source: 'wai-places',
      filter: ['all', [...unclustered], ['!=', ['get', 'planBadge'], '']],
      layout: { ...font, 'text-field': ['get', 'planBadge'], 'text-size': 11, 'text-offset': [1.2, 1], 'text-allow-overlap': true }, paint: textStyle });
  }
}
