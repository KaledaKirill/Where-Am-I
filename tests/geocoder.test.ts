import { describe, expect, it, vi } from 'vitest';
import { GeoapifyGeocoder } from '../src/adapters/geoapify-geocoder.js';
import { coordinates } from './fixtures.js';

const cityResult = { city: 'Нижний Новгород', state: 'Нижегородская область', county: 'Городской округ Нижний Новгород', country: 'Россия', country_code: 'ru',
  lat: 56.3, lon: 44, result_type: 'city', rank: { confidence: 1, match_type: 'full_match' } };

function setup(results: unknown[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ results })));
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

describe('interactive Geoapify search', () => {
  it('passes compound names intact, disables IP bias and accepts exact settlements', async () => {
    const f = setup([cityResult]);
    expect(await f.geocoder.search('Нижний Новгород Россия', true)).toEqual([{
      city: cityResult.city, region: cityResult.state, county: cityResult.county, country: 'Россия', country_code: 'ru',
      latitude: 56.3, longitude: 44, type: 'city', confidence: 1, exact: true,
    }]);
    const url = new URL(String(f.fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('text')).toBe('Нижний Новгород Россия');
    expect(url.searchParams.get('bias')).toBe('countrycode:none');
    expect(url.searchParams.get('type')).toBe('city');
    expect(url.searchParams.get('lang')).toBe('ru');
  });

  it('supports villages, compound country names and explicit country abbreviations parsed by the provider', async () => {
    const f = setup([{ ...cityResult, city: undefined, village: 'Новая Деревня', country: 'Соединённые Штаты Америки', country_code: 'us' }]);
    expect(await f.geocoder.search('Новая Деревня Соединённые Штаты Америки', true)).toMatchObject([{ city: 'Новая Деревня', exact: true }]);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ results: [cityResult], query: { parsed: { country: 'рф' } } })));
    expect(await f.geocoder.search('Нижний Новгород РФ', true)).toMatchObject([{ exact: false }]);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ results: [cityResult], query: { parsed: { country: 'Россия' } } })));
    expect(await f.geocoder.search('Россия', true)).toEqual([]);
  });

  it('keeps corrections for confirmation, rejects low confidence, missing countries, invalid coordinates and addresses', async () => {
    const f = setup([{ ...cityResult, rank: { confidence: 0.95, match_type: 'full_match' } }]);
    expect(await f.geocoder.search('Нижний Новогрод Россия', true)).toMatchObject([{ exact: false }]);
    expect(await f.geocoder.search('Нижний Новгород', true)).toEqual([]);
    for (const change of [{ rank: { confidence: 0.8 } }, { result_type: 'street' }, { lat: 100 }, { country_code: undefined }]) {
      expect(await setup([{ ...cityResult, ...change }]).geocoder.search('Нижний Новгород Россия', true)).toEqual([]);
    }
  });

  it('deduplicates equivalent municipalities but keeps names in different regions separate', async () => {
    const f = setup([{ ...cityResult, city: 'городской округ Нижний Новгород' }, cityResult, { ...cityResult, state: 'Другой регион' }]);
    const candidates = await f.geocoder.search('Нижний Новгород Россия', true);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.city).toBe('Нижний Новгород');
  });

  it.each(['country', 'state', 'county'] as const)('supports %s queries without restricting away countries', async (type) => {
    const f = setup([{ ...cityResult, result_type: type, city: undefined }]);
    const candidates = await f.geocoder.search('Россия', false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ type, city: '' });
    expect(new URL(String(f.fetcher.mock.calls[0]?.[0])).searchParams.has('type')).toBe(false);
    expect(await f.geocoder.search('Россия', true)).toEqual([]);
  });

  it('preserves country codes and counties during reverse geocoding without replacing Telegram coordinates', async () => {
    const f = setup([{ ...cityResult, distance: 0 }]);
    expect(await f.geocoder.reverse(coordinates)).toMatchObject({ country_code: 'ru', county: cityResult.county });
    expect(new URL(String(f.fetcher.mock.calls[0]?.[0])).searchParams.get('lat')).toBe(String(coordinates.latitude));
  });

  it('propagates timeouts and HTTP errors once, rather than returning candidates', async () => {
    const f = setup([]);
    f.fetcher.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(f.geocoder.search('Москва Россия', true)).rejects.toMatchObject({ status: 429 });
    f.fetcher.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    await expect(f.geocoder.search('Москва Россия', true)).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
