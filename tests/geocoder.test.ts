import { describe, expect, it, vi } from 'vitest';
import { GeoapifyGeocoder } from '../src/adapters/geoapify-geocoder.js';
import { coordinates } from './fixtures.js';

function setup(results: unknown[]) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results })));
  return { fetcher, geocoder: new GeoapifyGeocoder('secret-key', fetcher) };
}

describe('Geoapify', () => {
  it.each([
    [{ city: 'Москва' }, 'Москва'], [{ town: 'Тверь' }, 'Тверь'], [{ village: 'Деревня' }, 'Деревня'],
  ])('resolves settlements with city-level containment: %j', async (part, expected) => {
    const f = setup([{ ...part, country: 'Россия', state: 'Регион', distance: 0, result_type: 'city', lat: 1, lon: 2 }]);
    expect(await f.geocoder.reverse(coordinates)).toEqual({ city: expected, region: 'Регион', country: 'Россия' });
    const url = new URL(String(f.fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('type')).toBe('city');
    expect(url.searchParams.get('lat')).toBe(String(coordinates.latitude));
    expect(url.searchParams.get('lang')).toBe('ru');
  });

  it.each([
    [{ city: 'Ближайший город', state: 'Алтайский край', distance: 1200 }, { city: '', region: 'Алтайский край', country: 'Россия' }],
    [{}, { city: '', region: '', country: 'Россия' }],
    [{ city: 'Приблизительный город' }, { city: '', region: '', country: 'Россия' }],
  ])('falls back without inventing a city: %j', async (part, expected) => {
    expect(await setup([{ country: 'Россия', ...part }]).geocoder.reverse(coordinates)).toEqual(expected);
  });

  it('fails safely on HTTP 429, malformed responses and timeout without retries', async () => {
    const f = setup([]);
    f.fetcher.mockResolvedValueOnce(new Response('secret', { status: 429 }));
    await expect(f.geocoder.reverse(coordinates)).rejects.toMatchObject({ status: 429 });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValueOnce(new Response('{}'));
    await expect(f.geocoder.reverse(coordinates)).rejects.toThrow();
    f.fetcher.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(f.geocoder.reverse(coordinates)).rejects.toThrow();
  });

  it('geocodes Bali as a region and rejects ambiguous or low confidence places', async () => {
    const f = setup([{ name: 'Бали', state: 'Бали', country: 'Индонезия', lat: -8.4, lon: 115.1, result_type: 'state', rank: { confidence: 1 } }]);
    expect(await f.geocoder.forward('Бали, Индонезия')).toMatchObject({ city: '', region: 'Бали', country: 'Индонезия' });
    expect(new URL(String(f.fetcher.mock.calls[0]?.[0])).searchParams.get('type')).toBe('state');
    const ambiguous = setup(['A', 'B'].map((state) => ({ city: 'Город', state, country: 'Россия', lat: 1, lon: 2, result_type: 'city', rank: { confidence: 1 } })));
    await expect(ambiguous.geocoder.forward('Город')).rejects.toMatchObject({ reason: 'ambiguous' });
    await expect(setup([{ country: 'Россия', result_type: 'city', lat: 1, lon: 2, rank: { confidence: 0.1 } }]).geocoder.forward('Что-то')).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('merges equivalent city/municipality candidates and preserves a county name', async () => {
    const f = setup(['городской округ Тверь', 'Тверь'].map((city) => ({ name: city, city, state: 'Тверская область', country: 'Россия', lat: 1, lon: 2, result_type: 'city', rank: { confidence: 1 } })));
    expect(await f.geocoder.forward('Тверь, Россия')).toMatchObject({ city: 'Тверь' });
    const county = setup([{ name: 'Стамбул', county: 'Стамбул', state: 'Мраморноморский регион', country: 'Турция', lat: 41, lon: 29, result_type: 'county', rank: { confidence: 1 } }]);
    expect(await county.geocoder.forward('Стамбул, Турция')).toMatchObject({ city: '', region: 'Стамбул' });
  });

  it('falls back to a country lookup if settlement and state lookups are empty', async () => {
    const f = setup([]);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ country: 'Россия', result_type: 'country', distance: 0 }] })));
    expect(await f.geocoder.reverse(coordinates)).toEqual({ city: '', region: '', country: 'Россия' });
    expect(f.fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('type'))).toEqual(['city', 'state', 'country']);
  });
});
