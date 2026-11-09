import { describe, expect, it, vi } from 'vitest';
import { LocationService, normalizeInput } from '../src/services/location-service.js';
import { author, current, MemoryRepository } from './fixtures.js';

describe('LocationService', () => {
  it('preserves entered text and records each successful check-in without geocoding', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const repo = new MemoryRepository();
    let ticks = 0;
    const service = new LocationService(repo, () => new Date(Date.parse(current.updated_at) + ticks++ * 1000));
    await service.setLocation(author, '  Берлин,   Германия ');
    expect(repo.users.get('1001')?.location).toBe('Берлин,   Германия');
    await service.setLocation({ ...author, display_name: 'Новое имя', username: null }, 'Берлин Германия');
    expect(repo.users.get('1001')).toMatchObject({ display_name: 'Новое имя', username: null, updated_at: '2026-11-09T12:00:01.000Z' });
    expect(repo.history[1]?.recorded_at).toBe(repo.users.get('1001')?.updated_at);
    await service.setLocation(author, 'Берлин Германия');
    expect(repo.users.size).toBe(1);
    expect(repo.history).toHaveLength(3);
    expect(repo.history[0]?.location).toBe('Берлин,   Германия');
    expect(repo.history[2]?.recorded_at).toBe(repo.users.get('1001')?.updated_at);
    expect((await service.getMe('1001'))?.location).toBe('Берлин Германия');
    expect(await service.getMe('999')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not consult a dictionary or reject invented place names', async () => {
    const repo = new MemoryRepository();
    await new LocationService(repo).setLocation(author, 'Выдуманный город, Выдуманная страна');
    expect(repo.users.get('1001')?.location).toBe('Выдуманный город, Выдуманная страна');
  });

  it('rejects missing city or country before writing', async () => {
    const repo = new MemoryRepository();
    const save = vi.spyOn(repo, 'saveLocation');
    await expect(new LocationService(repo).setLocation(author, 'Берлин')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(save).not.toHaveBeenCalled();
  });

  it('maps storage failures to temporary errors while preserving their cause', async () => {
    const repo = new MemoryRepository();
    const service = new LocationService(repo);
    const error = new Error('secret');
    vi.spyOn(repo, 'saveLocation').mockRejectedValue(error);
    await expect(service.setLocation(author, 'Берлин Германия')).rejects.toMatchObject({ code: 'unavailable', cause: error });
    vi.spyOn(repo, 'getUser').mockRejectedValue(error);
    vi.spyOn(repo, 'listUsers').mockRejectedValue(error);
    await expect(service.getMe('1001')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(service.listGroups()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('groups case, comma and whitespace variants but preserves distinct text and sorts names', async () => {
    const repo = new MemoryRepository();
    repo.users.set('1', { ...current, user_id: '1', display_name: 'Яна' });
    repo.users.set('2', { ...current, user_id: '2', location: 'берлин   германия', display_name: 'Анна' });
    repo.users.set('3', { ...current, user_id: '3', location: 'Берлин, США' });
    repo.users.set('4', { ...current, user_id: '4', location: 'Berlin Germany' });
    const groups = await new LocationService(repo).listGroups();
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.key === 'берлин германия')?.users.map((u) => u.display_name)).toEqual(['Анна', 'Яна']);
    expect(groups.some((g) => g.label === 'Берлин, США')).toBe(true);
    expect(groups.some((g) => g.label === 'Berlin Germany')).toBe(true);
  });
});

describe('input validation', () => {
  it.each(['', '   ', 'Берлин', 'Берлин,', ', Германия', 'Берлин,,Германия', 'Минск, Беларусь, Европа', '1, 2', 'А'.repeat(121), 'Минск\nБеларусь'])('rejects %j', (value) => {
    expect(() => normalizeInput(value)).toThrow();
  });
  it.each([
    'Берлин, Германия', 'Берлин Германия', 'Германия, Берлин', 'Нью Йорк, США', 'Нью Йорк США',
    "Saint-Étienne, France", 'Сан-Паулу Бразилия', '北京 中国', '6th of October, Egypt',
    '  Ｂｅｒｌｉｎ,   Germany  ',
  ])('accepts %j preserving the original text', (value) => {
    expect(normalizeInput(value)).toBe(value.trim());
  });
});
