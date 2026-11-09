import { describe, expect, it, vi } from 'vitest';
import { LocationService, normalizeInput } from '../src/services/location-service.js';
import { author, berlin, current, MemoryRepository } from './fixtures.js';

describe('LocationService', () => {
  it('stores each successful check-in, updating one current user and the profile', async () => {
    const repo = new MemoryRepository();
    const resolver = { resolve: vi.fn().mockResolvedValue([berlin]) };
    let ticks = 0;
    const service = new LocationService(repo, resolver, () => new Date(Date.parse(current.updated_at) + ticks++ * 1000));
    await service.setLocation(author, '  Берлин,   Германия ');
    await service.setLocation({ ...author, display_name: 'Новое имя', username: null }, 'Германия, Берлин');
    expect(repo.users.get('1001')).toMatchObject({ display_name: 'Новое имя', username: null, updated_at: '2026-11-09T12:00:01.000Z' });
    expect(repo.history[1]?.recorded_at).toBe(repo.users.get('1001')?.updated_at);
    resolver.resolve.mockResolvedValue([{ ...berlin, place_key: 'nominatim:node:1', city: 'Варшава' }]);
    await service.setLocation(author, 'Варшава, Польша');
    expect(repo.users.size).toBe(1);
    expect(repo.history).toHaveLength(3);
    expect(repo.history[2]?.recorded_at).toBe(repo.users.get('1001')?.updated_at);
    expect(repo.history[0]?.recorded_at).toBe('2026-11-09T12:00:00.000Z');
    expect(repo.history[1]?.city).toBe('Берлин');
    expect((await service.getMe('1001'))?.city).toBe('Варшава');
    expect(await service.getMe('999')).toBeNull();
    expect(resolver.resolve).toHaveBeenNthCalledWith(1, 'Берлин, Германия');
    expect(resolver.resolve).toHaveBeenNthCalledWith(2, 'Германия, Берлин');
  });

  it('accepts duplicate results for the same OSM object', async () => {
    const repo = new MemoryRepository();
    await new LocationService(repo, { resolve: async () => [berlin, berlin] }).setLocation(author, 'Berlin');
    expect(repo.history).toHaveLength(1);
  });

  it.each([
    { results: [], code: 'not_found' },
    { results: [berlin, { ...berlin, place_key: 'nominatim:node:2' }], code: 'ambiguous' },
  ])('does not write for $code', async ({ results, code }) => {
    const repo = new MemoryRepository();
    await expect(new LocationService(repo, { resolve: async () => results }).setLocation(author, 'Берлин'))
      .rejects.toMatchObject({ code });
    expect(repo.history).toHaveLength(0);
  });

  it('maps API failures to temporary errors, including writes and reads', async () => {
    const repo = new MemoryRepository();
    const service = new LocationService(repo, { resolve: async () => [berlin] });
    vi.spyOn(repo, 'saveLocation').mockRejectedValue(new Error('secret'));
    await expect(service.setLocation(author, 'Берлин')).rejects.toMatchObject({ code: 'unavailable' });
    vi.spyOn(repo, 'getUser').mockRejectedValue(new Error('secret'));
    vi.spyOn(repo, 'listUsers').mockRejectedValue(new Error('secret'));
    await expect(service.getMe('1001')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.listGroups()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(new LocationService(repo, { resolve: async () => { throw new Error('timeout'); } })
      .setLocation(author, 'Берлин')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('groups by identity, disambiguates regions and sorts Russian names', async () => {
    const repo = new MemoryRepository();
    repo.users.set('1', { ...current, user_id: '1', display_name: 'Яна' });
    repo.users.set('2', { ...current, user_id: '2', display_name: 'Анна' });
    repo.users.set('3', { ...current, user_id: '3', place_key: 'other', region: 'Другой регион' });
    const groups = await new LocationService(repo, { resolve: async () => [] }).listGroups();
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.place_key === berlin.place_key)?.users.map((u) => u.display_name)).toEqual(['Анна', 'Яна']);
    expect(groups.find((g) => g.place_key === 'other')?.label).toContain('Другой регион');
  });
});

describe('input validation', () => {
  it.each(['', '   ', '1, 2', 'https://example.org', 'www.example.org', 'Берлин, ул. Мира', 'Berlin Main Street', 'Paris 12', 'А'.repeat(121)])('rejects %j', (value) => {
    expect(() => normalizeInput(value)).toThrow();
  });
  it.each(['Берлин, Германия', 'Германия, Берлин', "Saint-Étienne, France", 'Сан-Паулу, Бразилия', '北京, 中国'])('accepts %s', (value) => {
    expect(normalizeInput(value)).toBe(value);
  });
  it('normalizes unicode and whitespace', () => {
    expect(normalizeInput('  Ｂｅｒｌｉｎ,　 Germany  ')).toBe('Berlin, Germany');
  });
});
