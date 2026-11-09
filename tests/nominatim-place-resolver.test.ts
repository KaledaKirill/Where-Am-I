import { afterEach, describe, expect, it, vi } from 'vitest';
import { NominatimPlaceResolver, parsePlace } from '../src/adapters/nominatim-place-resolver.js';
import { berlin } from './fixtures.js';
import { captureLogs } from './logging-fixture.js';

const raw = {
  osm_type: 'relation', osm_id: 62422, lat: '52.52', lon: '13.405',
  category: 'boundary', type: 'administrative', addresstype: 'city',
  address: { city: 'Берлин', state: 'Берлин', country: 'Германия', country_code: 'de' },
};
const userAgent = 'WhereAmI/1.0 (contact: owner@my-travel-group.org)';

afterEach(() => vi.useRealTimers());

describe('Nominatim mapping', () => {
  it('maps a settlement boundary with a stable OSM key and numeric coordinates', () => {
    expect(parsePlace(raw)).toEqual(berlin);
    expect(parsePlace({ ...raw, category: 'place', type: 'town' })).toEqual(berlin);
  });

  it.each([
    { category: 'highway', type: 'residential' },
    { category: 'tourism', type: 'hotel' },
    { category: 'boundary', type: 'administrative', addresstype: 'state' },
    { lat: 'NaN' }, { lon: 181 }, { lat: '' }, { osm_type: 'bogus' }, { osm_id: 'bad' },
    { address: { country: 'Германия', country_code: 'de' } },
    { address: { city: 'Берлин', country: 'Германия', country_code: 'DEU' } },
  ])('rejects non-settlement or malformed result %j', (override) => {
    expect(parsePlace({ ...raw, ...override })).toBeNull();
  });

  it('supports villages with optional regions', () => {
    expect(parsePlace({ ...raw, category: 'place', type: 'village', address: { village: 'Деревня', country: 'Беларусь', country_code: 'by' } }))
      .toMatchObject({ city: 'Деревня', region: null, country_code: 'BY' });
  });
});

describe('Nominatim transport', () => {
  it('logs failed requests with status while omitting query, contact and response body', async () => {
    const capture = captureLogs();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-key', { status: 429 }));
    const resolver = new NominatimPlaceResolver(userAgent, undefined, fetcher, capture.logger);
    await expect(resolver.resolve('Берлин')).rejects.toThrow();
    expect(capture.records.at(-1)).toMatchObject({ event: 'nominatim_search_failed', http_status: 429 });
    for (const secret of ['Берлин', 'private-key', userAgent]) expect(capture.output()).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('passes the full query, language, user agent and timeout signal; deduplicates results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([raw, raw]));
    const resolver = new NominatimPlaceResolver(userAgent, 'https://geo.test/custom/', fetcher);
    expect(await resolver.resolve('Германия, Берлин')).toEqual([berlin]);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('https://geo.test/custom/search?');
    expect(new URL(String(url)).searchParams.get('q')).toBe('Германия, Берлин');
    expect(new URL(String(url)).searchParams.get('accept-language')).toBe('ru');
    expect(options?.headers).toMatchObject({ 'User-Agent': userAgent });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('spaces concurrent request starts at least one second apart and does not cache', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      starts.push(Date.now()); return Response.json([raw]);
    });
    const resolver = new NominatimPlaceResolver(userAgent, undefined, fetcher);
    const pending = Promise.all([resolver.resolve('Берлин'), resolver.resolve('Берлин'), resolver.resolve('Берлин')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(1000);
  });

  it.each([429, 500])('does not retry HTTP %i', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(new NominatimPlaceResolver(userAgent, undefined, fetcher).resolve('Берлин')).rejects.toThrow('недоступен');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates timeout and malformed payload, and returns empty search results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    await expect(new NominatimPlaceResolver(userAgent, undefined, fetcher).resolve('Берлин')).rejects.toThrow('timeout');
    fetcher.mockResolvedValue(Response.json({ error: 'bad' }));
    await expect(new NominatimPlaceResolver(userAgent, undefined, fetcher).resolve('Берлин')).rejects.toThrow('ответ');
    fetcher.mockResolvedValue(Response.json([]));
    expect(await new NominatimPlaceResolver(userAgent, undefined, fetcher).resolve('Берлин')).toEqual([]);
  });
});
