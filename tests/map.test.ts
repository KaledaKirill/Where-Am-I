import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Api, Bot } from 'grammy';
import type { Logger } from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { mapAuth } from '../src/map/auth.js';
import { ParticipantColors } from '../src/map/client/colors.js';
import { lineSegments, mapBounds, scene } from '../src/map/client/geometry.js';
import { participantSearch } from '../src/map/client/panels.js';
import { describePlace, PlaceResolver } from '../src/map/places.js';
import { MapService } from '../src/map/service.js';
import type { MapPlace } from '../src/map/types.js';
import { botFixture, messageUpdate } from './bot-fixture.js';
import { candidate, current, env, event } from './fixtures.js';
import { registerCommands } from '../src/bot/commands.js';
import { isGroupMember } from '../src/bot/membership.js';
import { captureLogs } from './logging-fixture.js';

function launchData(id: number, timestamp = Date.now(), token = env.TELEGRAM_BOT_TOKEN) {
  const fields = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Артём', username: 'artem' }),
    auth_date: String(Math.floor(timestamp / 1000)), signature: 'example', query_id: 'launch' });
  fields.sort();
  const payload = [...fields].map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  fields.set('hash', createHmac('sha256', key).update(payload).digest('hex'));
  return fields.toString();
}

const center = { ...candidate, latitude: 52.51, longitude: 13.4 };
const warsaw = { ...candidate, country: 'Польша', country_code: 'pl', city: 'Варшава', region: 'Мазовия', longitude: 21, latitude: 52.23 };

function fixture(logger: Logger | boolean = false) {
  const { bot, repo, service } = botFixture();
  repo.users.set('1001', { ...current, destination: warsaw, latitude: 52.52111, longitude: 13.40222 });
  repo.users.set('1002', { ...current, user_id: '1002', display_name: 'Борис', destination: warsaw });
  repo.users.set('1003', { ...current, user_id: '1003', display_name: 'Ушёл', destination: warsaw });
  repo.history.push(event, { ...event, recorded_at: '2025-03-07T12:00:00Z' },
    { ...event, recorded_at: 'не сохранилась' }, { ...event, user_id: '1002' }, { ...event, user_id: '1003' });
  const history = vi.spyOn(repo, 'listHistory');
  const member = vi.fn(async (id: number) => id !== 1003);
  const lookup = vi.fn(async (query: string) => [query.includes('Варшава') ? warsaw : center]);
  const map = new MapService(repo, member, new PlaceResolver(lookup));
  const app = createApp(loadConfig({ ...env, GEOAPIFY_MAPS_API_KEY: 'public-tiles-key', MAP_APP_SHORT_NAME: 'travel_map' }), service, bot, logger, undefined, map);
  return { repo, app, history, member, lookup };
}

describe('Telegram Mini App map API', () => {
  it('starts serving HTTP with the map enabled before Telegram bot initialization', async () => {
    const { repo, service } = botFixture();
    const fetcher = vi.fn();
    const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { client: { fetch: fetcher } });
    const map = new MapService(repo, async () => true, new PlaceResolver(async () => []));
    const config = loadConfig({ ...env, GEOAPIFY_MAPS_API_KEY: 'public-tiles-key' });
    const app = createApp(config, service, bot, false, undefined, map);

    expect((await app.inject('/health')).statusCode).toBe(200);
    const session = await app.inject({ method: 'POST', url: '/api/map/session', payload: { initData: launchData(1001) } });
    expect(session.statusCode).toBe(200);
    expect(session.json().checkInUrl).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    await app.close();
  });

  it('validates the Telegram launch, session identity and group membership on every request', async () => {
    const { app, member } = fixture();
    const start = (initData: string, origin = env.PUBLIC_BASE_URL) => app.inject({
      method: 'POST', url: '/api/map/session', headers: { origin }, payload: { initData },
    });
    expect((await start(launchData(1001).replace('artem', 'visitor'))).statusCode).toBe(401);
    expect((await start(`${launchData(1001)}&auth_date=1`)).statusCode).toBe(401);
    expect((await start(launchData(1001, Date.now() - 360_000))).statusCode).toBe(401);
    expect((await start(launchData(1001), 'https://unrelated.example')).statusCode).toBe(403);
    expect((await start(launchData(1003))).statusCode).toBe(403);
    const session = await start(launchData(1001));
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('no-store');
    expect(session.json()).toMatchObject({ viewerId: '1001' });
    expect(session.body).toContain('public-tiles-key');
    expect(session.body).not.toContain(env.GEOAPIFY_API_KEY);
    expect(session.body).not.toContain(env.TELEGRAM_BOT_TOKEN);
    const request = (token: string, payload = {}) => app.inject({ method: 'POST', url: '/api/map/data',
      headers: { authorization: `Bearer ${token}` }, payload: { mode: 'mine', ...payload } });
    const token = session.json().token as string;
    expect((await request(token.replace(/^1001/, '1002'))).statusCode).toBe(401);
    expect((await request(token, { viewerId: '1002' })).statusCode).toBe(400);
    member.mockResolvedValueOnce(false);
    expect((await request(token)).statusCode).toBe(403);
    member.mockRejectedValueOnce(new Error('telegram unavailable'));
    expect((await request(token)).statusCode).toBe(503);
    await app.close();
  });

  it('loads history only for selected active users and returns public place coordinates for every layer', async () => {
    const { app, repo, history, lookup, member } = fixture();
    const token = mapAuth(env.TELEGRAM_BOT_TOKEN).issue(1001);
    const request = (mode: string, participantIds?: string[]) => app.inject({ method: 'POST', url: '/api/map/data',
      headers: { authorization: `Bearer ${token}` }, payload: { mode, participantIds } });

    const now = await request('current');
    expect(now.statusCode).toBe(200);
    expect(now.json().participants.map((person: { id: string }) => person.id)).toEqual(['1001', '1002']);
    expect(now.json().travelers[0].current.place.point).toEqual([13.4, 52.51]);
    expect(now.json().travelers[0].destination).toBeUndefined();
    expect(history).not.toHaveBeenCalled();

    member.mockClear();
    const own = await request('mine', ['1002', '1003']);
    expect(member.mock.calls).toEqual([[1001]]);
    expect(own.json().participants).toHaveLength(1);
    expect(own.json().travelers).toEqual([expect.objectContaining({ id: '1001' })]);
    expect(own.json().travelers[0].history.map((row: { date: string | null }) => row.date)).toEqual(['2025-03-07', '2026-11-09', null]);
    expect(own.json().travelers[0].history[1].isLatest).toBe(true);
    expect(history).toHaveBeenLastCalledWith(new Set(['1001']));

    const plans = await request('plans', ['1001', '1003']);
    expect(history).toHaveBeenLastCalledWith(new Set(['1001']));
    expect(plans.json().travelers[0].destination).toMatchObject({ point: [21, 52.23], level: 'city' });
    expect(plans.body).not.toContain('13.40222');
    expect(plans.body).not.toContain('52.52111');
    expect(plans.body).not.toContain('coordinate_source');
    expect(lookup.mock.calls.every(([query]) => !query.includes('52.52'))).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    const nothing = await request('history', []);
    expect(nothing.json().travelers).toEqual([]);
    repo.users.delete('1001');
    expect((await request('mine')).json().travelers[0].history).toHaveLength(3);
    repo.history.length = 0;
    expect((await request('mine')).json().travelers).toEqual([]);
    history.mockRejectedValueOnce(new Error('Sheets unavailable'));
    expect((await request('mine')).statusCode).toBe(503);
    await app.close();
  });

  it('renders saved text check-ins, older geocoded places and plans during a lookup outage', async () => {
    const { app, repo, lookup } = fixture();
    const user = repo.users.get('1001')!;
    repo.users.set('1001', { ...user, coordinate_source: 'geocoded' });
    repo.history.push({ ...event, ...warsaw, coordinate_source: 'geocoded', recorded_at: '2025-01-01' });
    lookup.mockRejectedValue(new Error('Geoapify unavailable'));
    const result = await app.inject({ method: 'POST', url: '/api/map/data',
      headers: { authorization: `Bearer ${mapAuth(env.TELEGRAM_BOT_TOKEN).issue(1001)}` }, payload: { mode: 'plans', participantIds: ['1001'] } });
    const [traveler] = result.json().travelers;
    expect(traveler.current.place.point).toEqual([user.longitude, user.latitude]);
    expect(traveler.destination.point).toEqual([warsaw.longitude, warsaw.latitude]);
    expect(traveler.history[0].place.point).toEqual([warsaw.longitude, warsaw.latitude]);
    expect(lookup).not.toHaveBeenCalled();
    await app.close();
  });

  it('retries transient map reads once and reports the stage of a persistent failure', async () => {
    const logs = captureLogs();
    const { app, history, member } = fixture(logs.logger);
    const timeout = Object.assign(new Error('private location'), { code: 'ETIMEDOUT' });
    const request = () => app.inject({ method: 'POST', url: '/api/map/data',
      headers: { authorization: `Bearer ${mapAuth(env.TELEGRAM_BOT_TOKEN).issue(1001)}` }, payload: { mode: 'mine' } });
    member.mockRejectedValueOnce(timeout);
    history.mockRejectedValueOnce(timeout);
    expect((await request()).statusCode).toBe(200);
    expect(member).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledTimes(2);
    history.mockRejectedValue(timeout);
    expect((await request()).statusCode).toBe(503);
    expect(history).toHaveBeenCalledTimes(4);
    expect(logs.records).toContainEqual(expect.objectContaining({
      event: 'map_data_unavailable', stage: 'history_sheet', error_code: 'ETIMEDOUT',
    }));
    expect(logs.output()).not.toContain('private location');
    await app.close();
  });

  it('retries a grammY membership deadline and still requires a successful Telegram check', async () => {
    const logs = captureLogs();
    const { app, member, history } = fixture(logs.logger);
    const fetcher = vi.fn(async () => new Promise<never>(() => {}));
    const api = new Api(env.TELEGRAM_BOT_TOKEN, { timeoutSeconds: 0.01, fetch: fetcher });
    member.mockImplementation(id => isGroupMember(api, env.TELEGRAM_GROUP_ID, id));
    const request = () => app.inject({ method: 'POST', url: '/api/map/data',
      headers: { authorization: `Bearer ${mapAuth(env.TELEGRAM_BOT_TOKEN).issue(1001)}` }, payload: { mode: 'mine' } });

    expect((await request()).statusCode).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(history).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(expect.objectContaining({ event: 'map_data_unavailable',
      stage: 'viewer_membership', attempts: 2, error_type: 'TimeoutError', error_code: 'ETIMEDOUT' }));

    member.mockImplementationOnce(id => isGroupMember(api, env.TELEGRAM_GROUP_ID, id)).mockResolvedValueOnce(true);
    expect((await request()).statusCode).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(member).toHaveBeenCalledTimes(4);
    expect(history).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('expires signed sessions after an hour', () => {
    let now = Date.now();
    const auth = mapAuth(env.TELEGRAM_BOT_TOKEN, () => now);
    const session = auth.issue(1001);
    expect(auth.verifySession(`Bearer ${session}`)).toBe(1001);
    now += 60 * 60_000;
    expect(auth.verifySession(`Bearer ${session}`)).toBeNull();
  });

  it('exposes the Mini App from personal navigation and group list only when configured', async () => {
    const { bot, calls, service } = botFixture();
    registerCommands(bot, service, env.TELEGRAM_GROUP_ID, undefined, undefined, 'travel_map');
    await bot.handleUpdate(messageUpdate('/start', 1001));
    await bot.handleUpdate(messageUpdate('🗺 Карта', 1001));
    await bot.handleUpdate(messageUpdate('/help', 1001));
    await bot.handleUpdate(messageUpdate('/list'));
    expect(calls.filter(call => call.method === 'sendMessage').map(call => call.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '<b>🗺 Карта участников</b>\n\nПосмотри последние отметки, маршруты и планы поездок.\n\nВыбери участников или открой «Мою историю».',
        reply_markup: expect.objectContaining({ inline_keyboard: [[{ text: 'Открыть карту', url: 'https://t.me/WhereAmIBot/travel_map' }]] }) }),
      expect.objectContaining({ chat_id: -100123, reply_markup: expect.objectContaining({ inline_keyboard: expect.arrayContaining([
        [{ text: '🗺 Карта', url: 'https://t.me/WhereAmIBot/travel_map' }],
      ]) }) }),
    ]));
    const home = calls.find(call => call.method === 'sendMessage')?.payload.text;
    expect(home).not.toContain('Моя история');
    const help = calls.find(call => String(call.payload.text).startsWith('<b>Как пользоваться ботом</b>'))?.payload.text;
    expect(help).toContain('отметки, маршруты и планы участников группы');
  });
});

describe('map rendering data', () => {
  it('tries the short name with the same country restriction and rejects similarly named places in another region', async () => {
    const lookup = vi.fn(async (query: string) => query === 'Варшава' ? [warsaw] : []);
    const resolver = new PlaceResolver(lookup);
    const correct = describePlace(warsaw, new Map());
    const elsewhere = describePlace({ ...warsaw, region: 'Другой регион' }, new Map());
    await resolver.prepare([correct, elsewhere]);
    expect(lookup).toHaveBeenCalledWith('Варшава', 'city', 'pl');
    expect(resolver.point(correct).point).toEqual([21, 52.23]);
    expect(resolver.point(elsewhere).point).toBeNull();
    expect(correct.id).not.toBe(elsewhere.id);
  });

  it('recognizes a legacy district stored as a region only with a matching city and country', async () => {
    const shymkent = { ...candidate, city: 'Шымкент', region: '', country: 'Казахстан', country_code: 'kz' };
    const lookup = vi.fn(async (query: string) => query === 'Абайский район, Шымкент, Казахстан' ? [shymkent] : []);
    const resolver = new PlaceResolver(lookup);
    const place = describePlace({ ...shymkent, country_code: '', region: 'Абайский район' }, new Map());
    const unrelated = describePlace({ ...shymkent, country_code: '', region: 'Другая область' }, new Map());
    await resolver.prepare([place, unrelated]);
    expect(resolver.point(place).point).toEqual([shymkent.longitude, shymkent.latitude]);
    expect(resolver.point(unrelated).point).toBeNull();
  });

  it('fits the shortest longitude interval and splits history across the date line and unresolved places', () => {
    expect(mapBounds([[179, -8], [-179, 10]])).toEqual([[179, -8], [181, 10]]);
    expect(lineSegments([179, -8], [-179, 10])).toEqual([[[179, -8], [180, 1]], [[-180, 1], [-179, 10]]]);
    const place: MapPlace = { id: 'a', label: 'Город', level: 'city', point: [179, -8] };
    const value = scene([{ id: 'a', history: [
      { place, date: '2026-10-01' },
      { place: { ...place, id: 'missing', point: null }, date: '2026-10-03' },
      { place: { ...place, id: 'b', point: [-179, 10] }, date: '2026-10-07' },
    ] }], false, () => '#6848cb');
    expect(value.groups.size).toBe(3);
    expect(value.markers.features).toHaveLength(2);
    expect(value.routes.features).toHaveLength(0);
  });

  it('keeps multiple shared destinations and same-named places distinct', () => {
    const left: MapPlace = { id: 'region-one', label: 'Александровка', level: 'city', point: [25, 40] };
    const right: MapPlace = { ...left, id: 'region-two', point: [30, 41] };
    const value = scene(['a', 'b', 'c', 'd'].map((id, index) => ({ id, destination: index < 2 ? left : right })), false, () => '#6848cb');
    expect([...value.groups.values()].map(group => group.plans.size)).toEqual([2, 2]);
    expect(value.markers.features.map(feature => feature.properties?.size)).toEqual([2, 2]);
  });

  it('assigns distinct colors to all participants and preserves colors across modes and filtering', () => {
    const colors = new ParticipantColors();
    const ids = Array.from({ length: 140 }, (_, index) => String(1001 + index));
    colors.register(ids);
    for (const dark of [false, true]) {
      const resolve = (id: string) => colors.color(id, dark);
      expect(new Set(ids.map(resolve)).size).toBe(140);
      expect(resolve('1001')).not.toBe(resolve('1010'));
      const a: MapPlace = { id: 'a', label: 'Берлин', level: 'city', point: [13, 52] };
      const b: MapPlace = { id: 'b', label: 'Минск', level: 'city', point: [27, 54] };
      const c: MapPlace = { id: 'c', label: 'Варшава', level: 'city', point: [21, 52] };
      const old = { place: a, date: '2026-11-17' };
      const current = { place: b, date: '2026-11-18' };
      const first = { id: '1001', history: [old, current], current, destination: c };
      const second = { ...first, id: '1010' };
      const group = scene([first, second], dark, resolve);
      const mine = scene([first], dark, resolve);
      const strokes = (value: ReturnType<typeof scene>) => value.routes.features.map(feature => feature.properties?.color);
      expect(strokes(group)).toEqual([resolve('1001'), resolve('1001'), resolve('1010'), resolve('1010')]);
      expect(strokes(mine)).toEqual(strokes(group).slice(0, 2));
      expect(mine.markers.features.find(marker => marker.properties?.placeId === 'b')?.properties?.color).toBe(resolve('1001'));
    }
  });

  it('finds participants by name and username across a long directory', () => {
    const directory = Array.from({ length: 140 }, (_, i) => ({ id: String(i), name: `Артём ${i}`, username: `traveler_${i}` }));
    expect(participantSearch(directory, 'артем @traveler_139')).toEqual([directory[139]]);
    expect(participantSearch(directory, '@missing')).toEqual([]);
  });
});
