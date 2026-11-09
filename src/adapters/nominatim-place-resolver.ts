import { z } from 'zod';
import type { PlaceResolver } from '../domain/place-resolver.js';
import type { ResolvedPlace } from '../domain/models.js';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

const settlementTypes = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'isolated_dwelling']);
const optionalText = z.string().trim().min(1).optional();
const resultSchema = z.object({
  osm_type: z.enum(['node', 'way', 'relation']),
  osm_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
  lat: z.union([z.string().trim().min(1), z.number()]).transform(Number).pipe(z.number().finite().min(-90).max(90)),
  lon: z.union([z.string().trim().min(1), z.number()]).transform(Number).pipe(z.number().finite().min(-180).max(180)),
  category: z.string(), type: z.string(), addresstype: z.string().optional(),
  address: z.object({
    city: optionalText, town: optionalText, village: optionalText, hamlet: optionalText,
    municipality: optionalText, isolated_dwelling: optionalText,
    state: optionalText, region: optionalText, state_district: optionalText,
    country: z.string().trim().min(1), country_code: z.string().regex(/^[a-z]{2}$/i),
  }),
});

export function parsePlace(value: unknown): ResolvedPlace | null {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return null;
  const place = parsed.data;
  const kind = place.addresstype ?? place.type;
  const isSettlement = place.category === 'place' && settlementTypes.has(place.type);
  const isSettlementBoundary = place.category === 'boundary' && place.type === 'administrative'
    && settlementTypes.has(kind);
  if (!isSettlement && !isSettlementBoundary) return null;
  const address = place.address;
  const city = address.city ?? address.town ?? address.village ?? address.hamlet
    ?? address.isolated_dwelling ?? address.municipality;
  if (!city) return null;
  return {
    place_key: `nominatim:${place.osm_type}:${place.osm_id}`,
    city, region: address.state ?? address.region ?? address.state_district ?? null,
    country: address.country, country_code: address.country_code.toUpperCase(),
    latitude: place.lat, longitude: place.lon,
  };
}

export class NominatimPlaceResolver implements PlaceResolver {
  private startLock: Promise<void> = Promise.resolve();
  private lastStartedAt = -Infinity;

  constructor(
    private readonly userAgent: string,
    private readonly baseUrl = 'https://nominatim.openstreetmap.org',
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  private async waitForSlot(): Promise<void> {
    const previous = this.startLock;
    let release!: () => void;
    this.startLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // Recheck after waking: timers can fire slightly early.
      while (Date.now() - this.lastStartedAt < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() - this.lastStartedAt)));
      }
      this.lastStartedAt = Date.now();
    } finally { release(); }
  }

  async resolve(input: string): Promise<ResolvedPlace[]> {
    return logOperation(this.logger, 'nominatim_search', () => this.search(input), 'debug');
  }

  private async search(input: string): Promise<ResolvedPlace[]> {
    await this.waitForSlot();
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/search`);
    url.search = new URLSearchParams({ q: input, format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'ru' }).toString();
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Nominatim временно недоступен', { cause: { status: response.status } });
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('Некорректный ответ Nominatim');
    const places = body.map(parsePlace).filter((place): place is ResolvedPlace => place !== null);
    this.logger.debug({ event: 'nominatim_results_received', result_count: places.length });
    return [...new Map(places.map((place) => [place.place_key, place])).values()];
  }
}
