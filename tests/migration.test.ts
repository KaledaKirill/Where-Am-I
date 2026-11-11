import { expect, it, vi } from 'vitest';
import { normalizeLegacyLocation, planMigration, runMigration } from '../scripts/migrate-locations.js';
import type { Snapshot } from '../scripts/migrate-locations.js';
import { GeocodingError } from '../src/adapters/geoapify-geocoder.js';
import { current, coordinates, place } from './fixtures.js';
import { fakeSheets } from './sheets-fixture.js';

const legacy = {
  Users: [['user_id', 'display_name', 'username', 'location', 'updated_at'], ['1001', 'Анна', '', 'спб', current.updated_at]],
  LocationHistory: [['user_id', 'location', 'recorded_at'], ['1001', 'спб', current.updated_at], ['1001', 'Рязань → Челябинск, Россия', '2026-11-08T10:00:00.000Z']],
};
const snapshot = (): Snapshot => ({ sheets: Object.entries(legacy).map(([title, rows], id) => ({ title, rows, id })) });
const geocoder = () => ({ forward: vi.fn().mockResolvedValue({ ...place, ...coordinates }) });

it.each([
  ['Тверь(впишу) Россия', 'Тверь, Россия'],
  ['Рязань —> Челябинск, Россия', 'Челябинск, Россия'],
  ['Рязань → Челябинск', 'Челябинск'],
  ['Самара (—>Челябинск), Россия', 'Челябинск, Россия'],
  ['Москва, россия', 'Москва, Россия'],
  ['спб', 'Санкт-Петербург, Россия'],
  ['Бали', 'Бали, Индонезия'],
  ['  Москва ,,   Россия. ', 'Москва, Россия'],
])('normalizes %s to %s', (source, normalized) => expect(normalizeLegacyLocation(source)).toBe(normalized));

it('uses explicit overrides and refuses unknown personal comments or ambiguous routes', () => {
  expect(normalizeLegacyLocation('где-то (не знаю)')).toBeNull();
  expect(normalizeLegacyLocation('Москва / Тверь')).toBeNull();
  expect(normalizeLegacyLocation('странная строка', { 'странная строка': 'Тверь, Россия' })).toBe('Тверь, Россия');
  expect(normalizeLegacyLocation('не переносить', { 'не переносить': null })).toBeNull();
});

it('preserves original dates, IDs and existing history without synthesizing route events', async () => {
  const geo = geocoder();
  const plan = await planMigration(snapshot(), geo, {}, async () => {});
  expect(plan.report).toMatchObject({ source: 3, normalized: 3, skipped: 0 });
  expect(plan.tables.LocationHistory).toHaveLength(3);
  const columns = plan.tables.LocationHistory![0]!;
  expect(plan.tables.LocationHistory![2]![columns.indexOf('recorded_at')]).toBe('2026-11-08T10:00:00.000Z');
  expect(plan.tables.LocationHistory![2]![columns.indexOf('coordinate_source')]).toBe('geocoded');
  expect(geo.forward.mock.calls.map(([q]) => q)).toEqual(['Санкт-Петербург, Россия', 'Санкт-Петербург, Россия', 'Челябинск, Россия']);
});

it('does not invent history for a user who has none and preserves extra columns', async () => {
  const s = snapshot();
  s.sheets = s.sheets.filter((s) => s.title === 'Users');
  s.sheets[0]!.rows = [legacy.Users[0]!.concat('note'), legacy.Users[1]!.concat('keep')];
  const plan = await planMigration(s, geocoder(), {}, async () => {});
  expect(plan.tables.LocationHistory).toHaveLength(1);
  const cols = plan.tables.Users![0]!;
  expect(plan.tables.Users![1]![cols.indexOf('note')]).toBe('keep');
  expect(plan.tables.Users![1]![cols.indexOf('legacy_location')]).toBe('спб');
});

it('reports unrecognized and ambiguous places without choosing randomly', async () => {
  const geo = geocoder();
  geo.forward.mockRejectedValueOnce(new GeocodingError('not_found')).mockRejectedValueOnce(new GeocodingError('ambiguous'));
  const plan = await planMigration(snapshot(), geo, {}, async () => {});
  expect(plan.report).toMatchObject({ normalized: 1, skipped: 2 });
  expect(plan.report.unrecognized[0]?.reason).toBe('not_found');
  expect(plan.report.ambiguous[0]?.reason).toBe('ambiguous');
});

it('stops provider requests on 429 and never retries or applies a partial provider failure', async () => {
  const f = fakeSheets(legacy);
  const geo = geocoder();
  geo.forward.mockRejectedValue(new GeocodingError('http', 429));
  const artifacts = new Map();
  await expect(runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo, apply: true,
    saveArtifact: async (name, value) => { artifacts.set(name, value); }, pause: async () => {},
  })).rejects.toThrow('Provider failed');
  expect(geo.forward).toHaveBeenCalledTimes(1);
  expect(artifacts.get('report.json')).toMatchObject({ source: 3, skipped: 3, infrastructureErrors: 1 });
  expect(f.batchUpdate).not.toHaveBeenCalled();
});

it('defaults to dry-run, backs up all sheets and never changes Sheets', async () => {
  const f = fakeSheets({ ...legacy, Places: [['old'], ['keep']], Settings: [['key', 'value'], ['pinned_message_id', '9']] });
  const artifacts = new Map();
  const backup = structuredClone(Object.fromEntries(f.tables));
  const geo = geocoder();
  await runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo,
    saveArtifact: async (name, value) => { artifacts.set(name, structuredClone(value)); }, pause: async () => {},
  });
  expect(f.batchUpdate).not.toHaveBeenCalled();
  expect(Object.fromEntries(f.tables)).toEqual(backup);
  expect(artifacts.has('backup.json')).toBe(true);
  expect(artifacts.has('preview.json')).toBe(true);
  expect(artifacts.get('report.json')).toMatchObject({ source: 3, normalized: 3, skipped: 0 });
  expect((artifacts.get('backup.json') as Snapshot).sheets).toHaveLength(4);
});

it('applies once with a single atomic batch, remains readable and does not duplicate history when run again', async () => {
  const f = fakeSheets(legacy);
  const geo = geocoder();
  await runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo, apply: true, saveArtifact: async () => {}, pause: async () => {} });
  expect(f.batchUpdate).toHaveBeenCalledTimes(1);
  await f.repo.initialize();
  expect(await f.repo.getUser('1001')).toMatchObject({ ...coordinates, coordinate_source: 'geocoded' });
  geo.forward.mockClear();
  await runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo, apply: true, saveArtifact: async () => {}, pause: async () => {} });
  expect(geo.forward).not.toHaveBeenCalled();
  expect(f.tables.get('LocationHistory')).toHaveLength(3);
});

it('does not proceed if the backup fails or source data changes during planning', async () => {
  const f = fakeSheets(legacy);
  const geo = geocoder();
  await expect(runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo, apply: true, saveArtifact: async () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
  expect(geo.forward).not.toHaveBeenCalled();
  await expect(runMigration({ client: f.client, spreadsheetId: 'sheet', geocoder: geo, apply: true, pause: async () => {},
    saveArtifact: async (name) => { if (name === 'preview.json') f.tables.get('Users')!.push(['2', 'Другой', '', 'Москва', current.updated_at]); },
  })).rejects.toThrow('changed since backup');
  expect(f.batchUpdate).not.toHaveBeenCalled();
});

it('preserves history with a missing date, reports it, and rejects duplicate users and unknown schemas', async () => {
  const s = snapshot();
  s.sheets[0]!.rows = [...legacy.Users, legacy.Users[1]!];
  s.sheets[1]!.rows = [legacy.LocationHistory[0]!, ['1', 'спб', '']];
  const plan = await planMigration(s, geocoder(), {}, async () => {});
  expect(plan.report.ambiguous.map((i) => i.reason)).toEqual(['duplicate_user_id', 'duplicate_user_id']);
  expect(plan.report.warnings[0]?.reason).toBe('original_history_date_missing_or_unparseable');
  const cols = plan.tables.LocationHistory![0]!;
  expect(plan.tables.LocationHistory![1]![cols.indexOf('recorded_at')]).toBe('');
  await expect(planMigration({ sheets: [{ title: 'Users', id: 1, rows: [['who', 'where'], ['1', 'Москва']] }] }, geocoder())).rejects.toThrow('Unsupported schema');
});
