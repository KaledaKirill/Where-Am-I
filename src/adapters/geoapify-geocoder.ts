import { z } from 'zod';
import type { ForwardGeocoder, Geocoder } from '../domain/geocoder.js';
import { normalizePlace, validCoordinates } from '../domain/geocoder.js';
import type { Coordinates, Place, PlaceCandidate, PlaceType } from '../domain/models.js';

const resultSchema = z.object({
  country: z.string().trim().min(1), state: z.string().optional(), county: z.string().optional(),
  country_code: z.string().regex(/^[a-z]{2}$/i).optional(),
  city: z.string().optional(), town: z.string().optional(), village: z.string().optional(),
  name: z.string().optional(), result_type: z.string().optional(), distance: z.number().optional(),
  lat: z.number().optional(), lon: z.number().optional(),
  rank: z.object({ confidence: z.number().optional(), match_type: z.string().optional() }).optional(),
});
const responseSchema = z.object({ results: z.array(resultSchema), query: z.object({
  parsed: z.object({ country: z.string().optional() }).optional(),
}).optional() });
type Result = z.infer<typeof resultSchema>;

function place(result: Result): Place {
  return { city: result.city || result.town || result.village || '', region: result.state || result.county || '', country: result.country,
    ...(result.country_code ? { country_code: result.country_code.toLowerCase() } : {}),
    ...(result.county ? { county: result.county } : {}),
  };
}

function candidateIdentity(result: Result): string {
  const clean = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru').trim()
    .replace(/^(?:городской округ|город|г\.)\s+/u, '');
  // Geoapify can return both a settlement and its same-named municipality.
  // Collapse those only within the same country and region.
  return JSON.stringify([result.country, result.state || '', result.city || result.town || result.village || result.county || result.name || ''].map(clean));
}

export class GeocodingError extends Error {
  constructor(public readonly reason: 'ambiguous' | 'not_found' | 'http', public readonly status?: number) {
    super(`geocoding_${reason}`);
  }
}

export class GeoapifyGeocoder implements Geocoder, ForwardGeocoder {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: 'reverse' | 'search', parameters: Record<string, string>) {
    const url = new URL(`https://api.geoapify.com/v1/geocode/${path}`);
    url.search = new URLSearchParams({ bias: 'countrycode:none', ...parameters, lang: 'ru', format: 'json', apiKey: this.apiKey }).toString();
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new GeocodingError('http', response.status);
    return responseSchema.parse(await response.json());
  }

  async reverse(coordinates: Coordinates): Promise<Place> {
    if (!validCoordinates(coordinates)) throw new GeocodingError('not_found');
    let { results } = await this.request('reverse', {
      lat: String(coordinates.latitude), lon: String(coordinates.longitude), type: 'city', limit: '1',
    });
    if (!results.length) ({ results } = await this.request('reverse', {
      lat: String(coordinates.latitude), lon: String(coordinates.longitude), type: 'state', limit: '1',
    }));
    if (!results.length) ({ results } = await this.request('reverse', {
      lat: String(coordinates.latitude), lon: String(coordinates.longitude), type: 'country', limit: '1',
    }));
    const result = results[0];
    if (!result) throw new GeocodingError('not_found');
    const resolved = place(result);
    // Zero distance means the coordinate is inside the city area. Never select
    // a nearest settlement outside its boundary or infer one from a centroid.
    if (result.distance !== 0 || ['state', 'county', 'country'].includes(result.result_type ?? '')) resolved.city = '';
    return resolved;
  }

  async forward(query: string): Promise<Place & Coordinates> {
    const regional = query.toLocaleLowerCase('ru') === 'бали, индонезия';
    const { results } = await this.request('search', { text: query, limit: '5', ...(regional ? { type: 'state' } : {}) });
    const candidates = results.filter((r) => (r.rank?.confidence ?? 0) >= 0.9
      && ['city', 'state', 'county', 'country'].includes(r.result_type ?? '')
      && r.lat !== undefined && r.lon !== undefined);
    const identities = new Set(candidates.map(candidateIdentity));
    if (!candidates.length) throw new GeocodingError('not_found');
    if (identities.size !== 1) throw new GeocodingError('ambiguous');
    const result = candidates.find((r) => r.result_type === 'city' && !/^городской округ\s/iu.test(r.city || r.name || '')) ?? candidates[0]!;
    const resolved = place(result);
    if (['state', 'county', 'country'].includes(result.result_type!)) {
      resolved.city = '';
      if (result.result_type === 'county') resolved.region = result.county || result.name || result.state || '';
      else if (result.result_type === 'state') resolved.region = result.state || result.name || '';
    }
    const coordinates = { latitude: result.lat!, longitude: result.lon! };
    if (!validCoordinates(coordinates)) throw new GeocodingError('not_found');
    return { ...resolved, ...coordinates };
  }

  async search(query: string, settlementsOnly: boolean): Promise<PlaceCandidate[]> {
    // locality excludes countries; an unrestricted query is necessary for /find.
    let response = await this.request('search', { text: query, limit: '5', ...(settlementsOnly ? { type: 'city' } : {}) });
    // Some valid city names (e.g. Минск) return no unrestricted results, while
    // the same provider resolves them with an explicit settlement type.
    if (!settlementsOnly && !response.results.length) response = await this.request('search', { text: query, limit: '5', type: 'city' });
    const candidates = new Map<string, PlaceCandidate>();
    for (const result of response.results) {
      const type = result.result_type as PlaceType;
      if (!(settlementsOnly ? ['city'] : ['city', 'state', 'county', 'country']).includes(type)
        || (result.rank?.confidence ?? 0) < 0.9 || !result.country_code
        || result.lat === undefined || result.lon === undefined) continue;
      const coordinates = { latitude: result.lat, longitude: result.lon };
      if (!validCoordinates(coordinates)) continue;
      const resolved = place(result);
      if (type !== 'city') resolved.city = '';
      if (type === 'country') { resolved.region = ''; resolved.county = ''; }
      if (type === 'state') { resolved.region = result.state || result.name || ''; resolved.county = ''; }
      if (type === 'county') resolved.county = result.county || result.name || '';
      if (type === 'city' && !resolved.city) continue;
      const normalized = normalizePlace(query);
      const countryIncluded = [response.query?.parsed?.country, result.country].some((country) => {
        if (!country) return false;
        const suffix = ` ${normalizePlace(country)}`;
        return normalized.endsWith(suffix) && /\p{L}/u.test(normalized.slice(0, -suffix.length));
      });
      if (settlementsOnly && !countryIncluded) continue;
      const name = type === 'city' ? resolved.city : type === 'county' ? resolved.county! : type === 'state' ? resolved.region : resolved.country;
      if (!name.trim()) continue;
      const exactText = type === 'country' ? normalizePlace(name) : normalizePlace(`${name} ${resolved.country}`);
      const exact = result.rank?.confidence === 1 && result.rank.match_type === 'full_match'
        && (normalized === exactText || (!settlementsOnly && normalized === normalizePlace(name)));
      const candidate: PlaceCandidate = { ...resolved, ...coordinates, type, confidence: result.rank!.confidence!, exact };
      const identity = JSON.stringify([type, resolved.country_code || '', resolved.region, resolved.county || '', name.replace(/^(?:городской округ|город|г\.)\s+/iu, '')].map(normalizePlace));
      const previous = candidates.get(identity);
      if (!previous || candidate.exact || /^городской округ\s/iu.test(previous.city)) candidates.set(identity, candidate);
    }
    return [...candidates.values()];
  }
}
