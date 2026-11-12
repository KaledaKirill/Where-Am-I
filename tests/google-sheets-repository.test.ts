import { describe, expect, it } from 'vitest';
import { BASE_HISTORY_COLUMNS, BASE_USER_COLUMNS, HISTORY_COLUMNS, USER_COLUMNS } from '../src/adapters/google-sheets-repository.js';
import { fakeSheets } from './sheets-fixture.js';
import { candidate, current, event } from './fixtures.js';
import { captureLogs } from './logging-fixture.js';

describe('GoogleSheetsRepository', () => {
  it('creates missing sheets and headers, retaining all data on restart', async () => {
    const f = fakeSheets();
    await f.repo.initialize();
    expect([...f.tables.keys()]).toEqual(['Users', 'LocationHistory', 'Settings']);
    expect(f.tables.get('Users')).toEqual([[...USER_COLUMNS]]);
    expect(f.tables.get('Settings')).toEqual([['key', 'value']]);
    await f.repo.saveLocation(current, event);
    await f.repo.setSetting('pinned_message_id', '123');
    f.batchUpdate.mockClear();
    await f.repo.initialize();
    expect(f.batchUpdate).not.toHaveBeenCalled();
    expect(await f.repo.getUser('1001')).toEqual(current);
    expect(await f.repo.getSetting('pinned_message_id')).toBe('123');
  });

  it('refuses incompatible schemas before writes and never resets existing data', async () => {
    const initial = { Users: [['user_id', 'location', 'updated_at'], ['1', 'спб', current.updated_at]], Notes: [['keep']] };
    const f = fakeSheets(initial);
    await expect(f.repo.initialize()).rejects.toThrow('sheets_migration_required');
    expect(f.batchUpdate).not.toHaveBeenCalled();
    expect(Object.fromEntries(f.tables)).toEqual(initial);
  });

  it('writes the current user and history atomically as literal cells, including repeats', async () => {
    const f = fakeSheets();
    await f.repo.initialize();
    f.batchUpdate.mockClear();
    await f.repo.saveLocation({ ...current, display_name: '=IMPORTXML("secret")', username: null }, event);
    const requests = f.batchUpdate.mock.calls[0]![0].requestBody.requests!;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.appendCells?.rows?.[0]?.values?.[1]?.userEnteredValue).toEqual({ stringValue: '=IMPORTXML("secret")' });
    expect((await f.repo.getUser('1001'))?.username).toBeNull();
    await f.repo.saveLocation(current, event);
    expect(f.tables.get('Users')).toHaveLength(2);
    expect(f.tables.get('LocationHistory')).toHaveLength(3);
  });

  it('accepts a manual migration after starting on a legacy schema without restarting', async () => {
    const f = fakeSheets({ Users: [['user_id', 'location', 'updated_at'], ['1', 'спб', current.updated_at]] });
    await expect(f.repo.initialize()).rejects.toThrow('sheets_migration_required');
    await expect(f.repo.saveLocation(current, event)).rejects.toThrow('sheets_migration_required');
    expect(f.batchUpdate).not.toHaveBeenCalled();
    // The separate one-off migration supplies the complete schema.
    f.tables.set('Users', [[...USER_COLUMNS], USER_COLUMNS.map((c) => String((current as unknown as Record<string, unknown>)[c] ?? ''))]);
    await f.repo.saveLocation(current, event);
    expect(await f.repo.listUsers()).toEqual([current]);
    expect(f.tables.get('LocationHistory')).toHaveLength(2);
  });

  it('serializes saves and releases the lock after a failure without retries', async () => {
    const f = fakeSheets();
    await f.repo.initialize();
    f.batchUpdate.mockRejectedValueOnce(new Error('429'));
    await expect(f.repo.saveLocation(current, event)).rejects.toThrow('429');
    await Promise.all(Array.from({ length: 5 }, () => f.repo.saveLocation(current, event)));
    expect(await f.repo.listUsers()).toEqual([current]);
    expect(f.tables.get('LocationHistory')).toHaveLength(6);
  });

  it('preserves gaps, extra columns and reordered headers; rejects duplicate users', async () => {
    const columns = ['note', ...USER_COLUMNS].reverse();
    const record = { ...current, note: 'keep me' };
    const row = columns.map((c) => String((record as unknown as Record<string, unknown>)[c] ?? ''));
    const f = fakeSheets({ Users: [columns, [], row], LocationHistory: [[...HISTORY_COLUMNS]] });
    await f.repo.initialize();
    await f.repo.saveLocation(current, event);
    expect(f.tables.get('Users')?.[2]?.[columns.indexOf('note')]).toBe('keep me');
    expect(f.batchUpdate.mock.calls.at(-1)?.[0].requestBody.requests?.[0]?.updateCells?.start?.rowIndex).toBe(2);
    f.tables.get('Users')!.push(row);
    await expect(f.repo.listUsers()).rejects.toThrow('повторные');
  });

  it('reads and updates Settings after a new repository instance without duplicates', async () => {
    const f = fakeSheets();
    await f.repo.initialize();
    expect(await f.repo.getSetting('pinned_message_id')).toBeNull();
    await Promise.all([f.repo.setSetting('pinned_message_id', '100'), f.repo.setSetting('pinned_message_id', '200')]);
    expect(f.tables.get('Settings')).toEqual([['key', 'value'], ['pinned_message_id', '200']]);
    await f.repo.initialize();
    expect(await f.repo.getSetting('pinned_message_id')).toBe('200');
  });

  it('logs failures without personal data', async () => {
    const capture = captureLogs();
    const f = fakeSheets({}, capture.logger);
    await f.repo.initialize();
    await f.repo.saveLocation(current, event);
    f.batchUpdate.mockRejectedValueOnce(Object.assign(new Error('private-key'), { status: 429 }));
    await expect(f.repo.saveLocation(current, event)).rejects.toThrow();
    expect(capture.records).toContainEqual(expect.objectContaining({ event: 'sheets_save_location_failed', http_status: 429 }));
    for (const value of ['private-key', 'Берлин', 'Анна', '1001']) expect(capture.output()).not.toContain(value);
  });
});

it('appends only new headers to the existing normalized schema, preserving rows, settings and extra columns', async () => {
  const columns = ['note', ...BASE_USER_COLUMNS].reverse();
  const record = { ...current, note: 'keep' } as unknown as Record<string, unknown>;
  const row = columns.map((column) => String(record[column] ?? ''));
  const f = fakeSheets({ Users: [columns, row], LocationHistory: [[...BASE_HISTORY_COLUMNS]], Settings: [['key', 'value'], ['pinned_message_id', '42']] });
  await f.repo.initialize();
  expect(f.tables.get('Users')?.[1]).toEqual(row);
  expect(f.tables.get('Users')?.[0]?.slice(0, columns.length)).toEqual(columns);
  expect(await f.repo.getUser(current.user_id)).toEqual(current);
  expect(await f.repo.getSetting('pinned_message_id')).toBe('42');
  f.batchUpdate.mockClear();
  await f.repo.initialize();
  expect(f.batchUpdate).not.toHaveBeenCalled();
});

it('preflights all headers before additive upgrades and refuses duplicates or unknown schemas', async () => {
  const f = fakeSheets({ Users: [[...BASE_USER_COLUMNS]], LocationHistory: [['user_id']] });
  await expect(f.repo.initialize()).rejects.toThrow('sheets_migration_required');
  expect(f.batchUpdate).not.toHaveBeenCalled();
  const duplicate = fakeSheets({ Users: [[...BASE_USER_COLUMNS, 'country', 'country']] });
  await expect(duplicate.repo.initialize()).rejects.toThrow('sheets_migration_required');
  expect(duplicate.batchUpdate).not.toHaveBeenCalled();
});

it('updates only destination cells, preserves timestamps and history, and retains plans when saving a stale current user', async () => {
  const f = fakeSheets();
  await f.repo.saveLocation(current, event);
  const rows = structuredClone(f.tables.get('LocationHistory'));
  await f.repo.saveDestination(current.user_id, candidate);
  expect((await f.repo.getUser(current.user_id))?.destination).toMatchObject({ city: 'Берлин', country_code: 'de' });
  expect(f.batchUpdate.mock.calls.at(-1)?.[0].requestBody.requests).toHaveLength(7);
  await f.repo.saveLocation({ ...current, city: 'Другой город', destination: null }, event);
  expect((await f.repo.getUser(current.user_id))?.destination?.city).toBe('Берлин');
  await f.repo.saveDestination(current.user_id, null);
  expect((await f.repo.getUser(current.user_id))?.destination).toBeNull();
  expect((await f.repo.getUser(current.user_id))?.updated_at).toBe(current.updated_at);
  expect(f.tables.get('LocationHistory')?.slice(0, rows?.length)).toEqual(rows);
  expect(f.tables.get('LocationHistory')).toHaveLength(3);
});

it('does not coerce empty destination coordinates to zero and accepts actual zero coordinates', async () => {
  const f = fakeSheets();
  await f.repo.saveLocation(current, event);
  expect((await f.repo.getUser(current.user_id))?.destination).toBeNull();
  await f.repo.saveDestination(current.user_id, { ...candidate, latitude: 0, longitude: 0 });
  expect((await f.repo.getUser(current.user_id))?.destination).toMatchObject({ latitude: 0, longitude: 0 });
  const columns = f.tables.get('Users')![0]!;
  f.tables.get('Users')![1]![columns.indexOf('destination_latitude')] = '';
  await expect(f.repo.listUsers()).rejects.toThrow('пункт назначения');
});

it('serializes concurrent current/destination writes without losing plans and releases destination lock after failure', async () => {
  const f = fakeSheets();
  await f.repo.saveLocation(current, event);
  f.batchUpdate.mockRejectedValueOnce(new Error('network'));
  await expect(f.repo.saveDestination(current.user_id, candidate)).rejects.toThrow('network');
  await Promise.all([f.repo.saveDestination(current.user_id, candidate), f.repo.saveLocation(current, event)]);
  expect((await f.repo.getUser(current.user_id))?.destination?.city).toBe('Берлин');
  expect(f.tables.get('LocationHistory')).toHaveLength(3);
});
