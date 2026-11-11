import { describe, expect, it } from 'vitest';
import { HISTORY_COLUMNS, USER_COLUMNS } from '../src/adapters/google-sheets-repository.js';
import { fakeSheets } from './sheets-fixture.js';
import { current, event } from './fixtures.js';
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
    f.tables.set('Users', [[...USER_COLUMNS], USER_COLUMNS.map((c) => current[c] ?? '')]);
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
    const row = columns.map((c) => record[c as keyof typeof record] ?? '');
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
