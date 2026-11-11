import { describe, expect, it, vi } from 'vitest';
import { LocationService } from '../src/services/location-service.js';
import { author, coordinates, current, MemoryRepository, place } from './fixtures.js';

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
