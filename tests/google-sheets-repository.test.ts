import { describe, expect, it, vi } from 'vitest';
import type { sheets_v4 } from '@googleapis/sheets';
import { GoogleSheetsRepository, HISTORY_COLUMNS, USER_COLUMNS } from '../src/adapters/google-sheets-repository.js';
import type { SheetsClient } from '../src/adapters/google-sheets-repository.js';
import { current } from './fixtures.js';
import { silentLogger } from '../src/logging.js';
import { captureLogs } from './logging-fixture.js';

function fakeSheets(initial: Record<string, (string | number)[][]> = {}, logger = silentLogger) {
  const tables = new Map(Object.entries(initial));
  const ids = new Map(Object.keys(initial).map((title, i) => [title, i]));
  const get = vi.fn(async () => ({ data: { sheets: [...ids].map(([title, sheetId]) => ({ properties: { title, sheetId } })) } }));
  const valuesGet = vi.fn(async ({ range }: { range: string }) => {
    const title = range.match(/^'([^']+)'/)?.[1] ?? '';
    const table = tables.get(title) ?? [];
    return { data: { values: range.endsWith('!1:1') ? table.slice(0, 1) : range.endsWith('!A2:E') ? table.slice(1) : table } };
  });
  const batchUpdate = vi.fn(async ({ requestBody }: { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
    for (const request of requestBody.requests ?? []) {
      if (request.addSheet) {
        const { title, sheetId } = request.addSheet.properties!;
        ids.set(title!, sheetId!); tables.set(title!, []);
      }
      const update = request.updateCells;
      const append = request.appendCells;
      if (request.updateSheetProperties) {
        const { sheetId, gridProperties } = request.updateSheetProperties.properties!;
        const title = [...ids].find(([, id]) => id === sheetId)?.[0];
        if (title) for (const row of tables.get(title)!) row.splice(gridProperties!.columnCount!);
      }
      if (!update && !append) continue;
      const sheetId = update?.start?.sheetId ?? update?.range?.sheetId ?? append?.sheetId;
      const title = [...ids].find(([, id]) => id === sheetId)?.[0];
      if (!title) throw new Error('Unknown sheet');
      const table = tables.get(title)!;
      const rows = (update?.rows ?? append?.rows ?? []).map((row) => (row.values ?? []).map((cell) => cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.stringValue ?? ''));
      if (append) table.push(...rows);
      else {
        if (update?.range) table.length = 0;
        rows.forEach((row, offset) => { table[(update?.start?.rowIndex ?? 0) + offset] = row; });
      }
    }
    return { data: {} };
  });
  const client = { spreadsheets: { get, batchUpdate, values: { get: valuesGet } } } as unknown as SheetsClient;
  const repo = new GoogleSheetsRepository(client, 'sheet-id', logger);
  return { repo, get, valuesGet, batchUpdate, tables };
}
const event = { location: current.location, user_id: current.user_id, recorded_at: current.updated_at };

describe('GoogleSheetsRepository', () => {
  it('logs initialization, successful writes and failed writes without stored values or credentials', async () => {
    const capture = captureLogs();
    const fake = fakeSheets({}, capture.logger);
    await fake.repo.initialize();
    await fake.repo.saveLocation(current, event);
    fake.batchUpdate.mockRejectedValueOnce(Object.assign(new Error('private-key'), { response: { status: 429 } }));
    await expect(fake.repo.saveLocation(current, event)).rejects.toThrow();
    expect(capture.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'sheets_schema_ready', created_sheets: ['Users', 'LocationHistory'] }),
      expect.objectContaining({ event: 'sheets_save_location_completed' }),
      expect.objectContaining({ event: 'sheets_save_location_failed', http_status: 429 }),
    ]));
    for (const secret of ['private-key', 'sheet-id', 'Берлин', 'Анна', '1001']) expect(capture.output()).not.toContain(secret);
  });
  it('creates only missing sheets and headers, and is safe on restart', async () => {
    const fake = fakeSheets();
    await fake.repo.initialize();
    expect([...fake.tables.keys()]).toEqual(['Users', 'LocationHistory']);
    expect(fake.tables.get('Users')).toEqual([[...USER_COLUMNS]]);
    expect(fake.tables.get('LocationHistory')).toEqual([[...HISTORY_COLUMNS]]);
    await fake.repo.saveLocation(current, event);
    fake.batchUpdate.mockClear();
    await fake.repo.initialize();
    expect(fake.batchUpdate).not.toHaveBeenCalled();
    expect(await fake.repo.getUser(current.user_id)).toEqual(current);
  });

  it('replaces old schemas and all old records with compact text-only sheets', async () => {
    const fake = fakeSheets({
      Users: [['user_id', 'city', 'country', 'latitude'], ['1001', 'Минск', 'Беларусь', 53.9], [], ['2002', 'Other']],
      LocationHistory: [['user_id', 'city', 'longitude'], ['1001', 'Минск', 27.5]],
      Notes: [['keep me'], ['unchanged']],
    });
    await fake.repo.initialize();
    expect(fake.tables.get('Users')).toEqual([[...USER_COLUMNS]]);
    expect(fake.tables.get('LocationHistory')).toEqual([[...HISTORY_COLUMNS]]);
    expect(fake.tables.get('Notes')).toEqual([['keep me'], ['unchanged']]);
    expect(fake.batchUpdate).toHaveBeenCalledTimes(1);
    const resets = fake.batchUpdate.mock.calls[0]![0].requestBody.requests!.filter((r) => r.updateCells?.range);
    expect(resets).toHaveLength(2);
    expect(resets.every((r) => Object.keys(r.updateCells!.range!).length === 1)).toBe(true);
    expect(await fake.repo.listUsers()).toEqual([]);
    await fake.repo.saveLocation(current, event);
    fake.batchUpdate.mockClear();
    await fake.repo.initialize();
    expect(fake.batchUpdate).not.toHaveBeenCalled();
    expect(await fake.repo.getUser(current.user_id)).toEqual(current);
  });

  it('initializes empty headers and discards old records below them', async () => {
    const fake = fakeSheets({ Users: [[], [], ['old data']] });
    await fake.repo.initialize();
    expect(fake.tables.get('Users')).toEqual([[...USER_COLUMNS]]);
  });

  it('writes current location and history in one atomic request with typed values', async () => {
    const fake = fakeSheets();
    await fake.repo.initialize();
    fake.batchUpdate.mockClear();
    await fake.repo.saveLocation({ ...current, display_name: '=IMPORTXML("secret")', username: null }, event);
    expect(fake.batchUpdate).toHaveBeenCalledTimes(1);
    const requests = fake.batchUpdate.mock.calls[0]![0].requestBody.requests!;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.appendCells?.rows?.[0]?.values?.[0]?.userEnteredValue).toEqual({ stringValue: '1001' });
    expect(requests[0]?.appendCells?.rows?.[0]?.values?.[1]?.userEnteredValue).toEqual({ stringValue: '=IMPORTXML("secret")' });
    expect(requests[0]?.appendCells?.rows?.[0]?.values?.[3]?.userEnteredValue).toEqual({ stringValue: current.location });
    expect(requests[1]?.appendCells?.rows?.[0]?.values).toHaveLength(HISTORY_COLUMNS.length);
    expect((await fake.repo.getUser('1001'))?.username).toBeNull();
    await fake.repo.saveLocation(current, event);
    expect(fake.tables.get('Users')).toHaveLength(2);
    expect(fake.tables.get('LocationHistory')).toHaveLength(3);
    expect(fake.batchUpdate.mock.calls[1]?.[0].requestBody.requests?.[0]?.updateCells?.start?.rowIndex).toBe(1);
  });

  it('stores entered location as literal text even when it resembles a formula', async () => {
    const fake = fakeSheets();
    await fake.repo.initialize();
    const location = '=HYPERLINK("somewhere") Country';
    await fake.repo.saveLocation({ ...current, location }, { ...event, location });
    expect((await fake.repo.getUser('1001'))?.location).toBe(location);
    expect(fake.tables.get('LocationHistory')?.[1]?.[1]).toBe(location);
  });

  it('serializes concurrent read-modify-write operations for a new user', async () => {
    const fake = fakeSheets();
    await fake.repo.initialize();
    await Promise.all(Array.from({ length: 5 }, () => fake.repo.saveLocation(current, event)));
    expect(await fake.repo.listUsers()).toEqual([current]);
    expect(fake.tables.get('LocationHistory')).toHaveLength(6);
  });

  it('propagates failed writes without retry and releases its lock', async () => {
    const fake = fakeSheets();
    await fake.repo.initialize();
    fake.batchUpdate.mockClear();
    fake.batchUpdate.mockRejectedValueOnce(new Error('429'));
    await expect(fake.repo.saveLocation(current, event)).rejects.toThrow('429');
    expect(fake.batchUpdate).toHaveBeenCalledTimes(1);
    expect(fake.batchUpdate.mock.calls[0]).toHaveLength(2);
    await fake.repo.saveLocation(current, event);
    expect(await fake.repo.listUsers()).toHaveLength(1);
  });

  it('preserves physical row positions across gaps and rejects duplicate IDs', async () => {
    const row = USER_COLUMNS.map((key) => current[key] ?? '');
    const fake = fakeSheets({ Users: [[...USER_COLUMNS], [], row], LocationHistory: [[...HISTORY_COLUMNS]] });
    await fake.repo.initialize();
    await fake.repo.saveLocation(current, event);
    expect(fake.batchUpdate.mock.calls[0]?.[0].requestBody.requests?.[0]?.updateCells?.start?.rowIndex).toBe(2);
    fake.tables.get('Users')!.push(row);
    await expect(fake.repo.listUsers()).rejects.toThrow('повторные');
  });
});
