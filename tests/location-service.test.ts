import { describe, expect, it, vi } from 'vitest';
import { LocationService } from '../src/services/location-service.js';
import { author, candidate, coordinates, current, MemoryRepository, place } from './fixtures.js';

describe('LocationService', () => {
  it('creates, updates and records every repeated location with original Telegram coordinates', async () => {
    const repo = new MemoryRepository();
    const geocoder = { reverse: vi.fn().mockResolvedValue(place) };
    let ticks = 0;
    const service = new LocationService(repo, geocoder, () => new Date(Date.parse(current.updated_at) + ticks++ * 1000));
    await service.setLocation(author, coordinates);
    await service.setLocation({ ...author, display_name: 'Новое имя', username: null }, coordinates);
    await service.setLocation(author, coordinates);
    expect(repo.users.size).toBe(1);
    expect(repo.history).toHaveLength(3);
    expect(repo.history[0]).toMatchObject({ ...coordinates, coordinate_source: 'telegram', recorded_at: current.updated_at });
    expect(repo.history[2]?.recorded_at).toBe(repo.users.get(author.user_id)?.updated_at);
    expect(geocoder.reverse).toHaveBeenCalledTimes(3);
  });

  it('updates geographic fields and profile', async () => {
    const repo = new MemoryRepository();
    repo.users.set(author.user_id, current);
    const service = new LocationService(repo, { reverse: vi.fn().mockResolvedValue({ city: '', region: 'Алтайский край', country: 'Россия' }) });
    await service.setLocation({ ...author, username: null }, { latitude: 50, longitude: 80 });
    expect(repo.users.get(author.user_id)).toMatchObject({ city: '', location: 'Алтайский край, Россия', username: null, latitude: 50 });
    expect(repo.history).toHaveLength(1);
  });

  it('does not save partial records after geocoding failures', async () => {
    const repo = new MemoryRepository();
    const service = new LocationService(repo, { reverse: vi.fn().mockRejectedValue(new Error('apiKey=secret')) });
    await expect(service.setLocation(author, coordinates)).rejects.toMatchObject({ code: 'geocoding_failed' });
    expect(repo.users.size).toBe(0);
    expect(repo.history).toHaveLength(0);
  });

  it('maps storage failures without retry', async () => {
    const repo = new MemoryRepository();
    const save = vi.spyOn(repo, 'saveLocation').mockRejectedValue(new Error('secret'));
    const service = new LocationService(repo, { reverse: vi.fn().mockResolvedValue(place) });
    await expect(service.setLocation(author, coordinates)).rejects.toMatchObject({ code: 'unavailable' });
    expect(save).toHaveBeenCalledTimes(1);
    vi.spyOn(repo, 'listUsers').mockRejectedValue(new Error('storage'));
    await expect(service.listGroups()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([{ latitude: NaN, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }])('rejects invalid coordinates %j', async (input) => {
    const geocoder = { reverse: vi.fn() };
    await expect(new LocationService(new MemoryRepository(), geocoder).setLocation(author, input)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(geocoder.reverse).not.toHaveBeenCalled();
  });

  it('groups settlements by country and region and sorts names', async () => {
    const repo = new MemoryRepository();
    repo.users.set('1', { ...current, user_id: '1', display_name: 'Яна' });
    repo.users.set('2', { ...current, user_id: '2', city: 'берлин', display_name: 'Анна' });
    repo.users.set('3', { ...current, user_id: '3', region: 'Другой регион' });
    const groups = await new LocationService(repo, { reverse: vi.fn() }).listGroups();
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.users.length === 2)?.users.map((u) => u.display_name)).toEqual(['Анна', 'Яна']);
  });
});

describe('destinations and traveler search', () => {
  it('stores text coordinates, preserves plans on repeated check-ins, and clears only destination fields', async () => {
    const repo = new MemoryRepository();
    const service = new LocationService(repo, { reverse: vi.fn().mockResolvedValue(place) });
    await service.setTextLocation(author, candidate);
    expect(repo.history[0]).toMatchObject({ ...coordinates, coordinate_source: 'geocoded', country_code: 'de' });
    await service.setDestination(author.user_id, candidate);
    expect(repo.users.get(author.user_id)?.destination).toMatchObject({ ...coordinates, city: 'Берлин' });
    await service.setLocation(author, { latitude: 1, longitude: 2 });
    expect(repo.users.get(author.user_id)?.destination?.latitude).toBe(coordinates.latitude);
    expect(repo.history[1]).toMatchObject({ latitude: 1, longitude: 2, coordinate_source: 'telegram' });
    const previous = repo.users.get(author.user_id)!;
    await service.setDestination(author.user_id, null);
    expect(repo.users.get(author.user_id)).toEqual({ ...previous, destination: null });
    expect(repo.history).toHaveLength(2);
  });

  it('requires an existing current location for plans and never stores nonsettlement text marks', async () => {
    const repo = new MemoryRepository();
    const service = new LocationService(repo, { reverse: vi.fn() });
    await expect(service.setDestination(author.user_id, candidate)).rejects.toMatchObject({ code: 'no_location' });
    await expect(service.setTextLocation(author, { ...candidate, type: 'country' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(repo.history).toHaveLength(0);
  });

  it.each(['', '   ', 'a', 'Москва / Россия', 'x'.repeat(201), '12345'])('rejects malformed input %j before provider access', async (text) => {
    const search = vi.fn();
    const service = new LocationService(new MemoryRepository(), { reverse: vi.fn(), search });
    await expect(service.resolveText(text, true)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(search).not.toHaveBeenCalled();
  });

  it('distinguishes no matches, provider failures and repository failures without retries', async () => {
    const search = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('secret'));
    const repo = new MemoryRepository();
    repo.users.set(author.user_id, current);
    const service = new LocationService(repo, { reverse: vi.fn(), search });
    await expect(service.resolveText('Город Страна', true)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.resolveText('Город Страна', true)).rejects.toMatchObject({ code: 'geocoding_failed' });
    const save = vi.spyOn(repo, 'saveDestination').mockRejectedValue(new Error('secret'));
    await expect(service.setDestination(author.user_id, candidate)).rejects.toMatchObject({ code: 'unavailable' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('matches countries, states, counties and cities with hierarchy, legacy fallbacks, sorting and both categories', async () => {
    const repo = new MemoryRepository();
    const base = { ...current, country_code: 'de', county: 'Район', destination: { ...candidate, county: 'Район' } };
    repo.users.set('1', { ...base, user_id: '1', display_name: 'Яна' });
    repo.users.set('2', { ...base, user_id: '2', display_name: 'Анна', city: 'Другой город' });
    repo.users.set('3', { ...base, user_id: '3', region: 'Другая область', county: 'Другой район', destination: null });
    repo.users.set('4', { ...base, user_id: '4', country_code: '', destination: null });
    repo.users.set('5', { ...base, user_id: '5', country_code: 'us', destination: null });
    const service = new LocationService(repo, { reverse: vi.fn() });
    expect((await service.findTravelers({ ...candidate, type: 'country' })).current.map((user) => user.user_id)).toEqual(['2', '3', '4', '1']);
    expect((await service.findTravelers({ ...candidate, type: 'state' })).current.map((user) => user.user_id)).toEqual(['2', '4', '1']);
    expect((await service.findTravelers({ ...candidate, type: 'county', county: 'Район' })).current).toHaveLength(3);
    const city = await service.findTravelers(candidate);
    expect(city.current.map((user) => user.user_id)).toEqual(['4', '1']);
    expect(city.planned.map((user) => user.user_id)).toEqual(['2', '1']);
    expect(await service.findTravelers({ ...candidate, city: 'Бер' })).toEqual({ current: [], planned: [] });
  });

  it('matches a settlement with no region when both normalized region fields are empty', async () => {
    const repo = new MemoryRepository();
    repo.users.set('1001', { ...current, region: '', country_code: 'de' });
    const service = new LocationService(repo, { reverse: vi.fn() });
    expect((await service.findTravelers({ ...candidate, region: '' })).current).toHaveLength(1);
  });
});
