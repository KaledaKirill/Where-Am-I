import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { LocationRepository } from '../domain/location-repository.js';
import type { CurrentUser, LocationHistoryEntry } from '../domain/models.js';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

export const USER_COLUMNS = ['user_id', 'display_name', 'username', 'location', 'updated_at', 'city', 'region', 'country', 'latitude', 'longitude', 'coordinate_source'] as const;
export const HISTORY_COLUMNS = ['user_id', 'location', 'recorded_at', 'city', 'region', 'country', 'latitude', 'longitude', 'coordinate_source'] as const;
export const SETTINGS_COLUMNS = ['key', 'value'] as const;
export const TABLE_COLUMNS = { Users: USER_COLUMNS, LocationHistory: HISTORY_COLUMNS, Settings: SETTINGS_COLUMNS };
export type SheetsClient = Pick<sheets_v4.Sheets, 'spreadsheets'>;
export const requestOptions = { retry: false, timeout: 10_000 };

export const locatedSchema = z.object({
  city: z.string(), region: z.string(), country: z.string().min(1), location: z.string().min(1),
  latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180),
  coordinate_source: z.enum(['telegram', 'geocoded']),
});
export const currentUserSchema = locatedSchema.extend({
  user_id: z.string().regex(/^\d+$/), display_name: z.string().min(1),
  username: z.string().nullable(), updated_at: z.iso.datetime({ offset: true }),
});

export function cells(values: unknown[]): sheets_v4.Schema$RowData {
  return { values: values.map((value) => ({ userEnteredValue: { stringValue: value === null || value === undefined ? '' : String(value) } })) };
}

export function createSheetsClient(config: Config): SheetsClient {
  const auth = new GoogleAuth({
    credentials: { client_email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return sheets({ version: 'v4', auth });
}

export function createGoogleSheetsRepository(config: Config, logger: AppLogger = silentLogger): GoogleSheetsRepository {
  return new GoogleSheetsRepository(createSheetsClient(config), config.GOOGLE_SPREADSHEET_ID, logger);
}

export class GoogleSheetsRepository implements LocationRepository {
  private tables = new Map<string, { id: number; columns: string[] }>();
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly client: SheetsClient, private readonly spreadsheetId: string, private readonly logger: AppLogger = silentLogger) {}

  async initialize(): Promise<void> {
    return logOperation(this.logger, 'sheets_initialize', async () => {
      const { data } = await this.client.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(sheetId,title)' }, requestOptions);
      const existing = new Map((data.sheets ?? []).map((s) => [s.properties?.title, s.properties?.sheetId]));
      let nextId = Math.max(0, ...[...existing.values()].map((id) => id ?? 0)) + 1;
      const requests: sheets_v4.Schema$Request[] = [];
      const tables = new Map<string, { id: number; columns: string[] }>();
      for (const [title, columns] of Object.entries(TABLE_COLUMNS)) {
        const id = existing.get(title) ?? nextId++;
        if (existing.has(title)) {
          const { data: header } = await this.client.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `'${title}'!1:1`, valueRenderOption: 'UNFORMATTED_VALUE' }, requestOptions);
          const row = (header.values?.[0] ?? []).map(String);
          // Preflight every existing header BEFORE making any changes.
          if (new Set(row).size !== row.length || columns.some((c) => !row.includes(c))) {
            throw new Error('sheets_migration_required');
          }
          tables.set(title, { id, columns: row });
        } else {
          requests.push({ addSheet: { properties: { sheetId: id, title, gridProperties: { columnCount: columns.length } } } });
          requests.push({ updateCells: { start: { sheetId: id, rowIndex: 0, columnIndex: 0 }, rows: [cells([...columns])], fields: 'userEnteredValue' } });
          tables.set(title, { id, columns: [...columns] });
        }
      }
      if (requests.length) await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }, requestOptions);
      this.tables = tables;
      this.logger.info({ event: 'sheets_schema_ready', initialized: true });
    });
  }

  private table(title: string) {
    const table = this.tables.get(title);
    if (!table) throw new Error('Repository не инициализирован');
    return table;
  }

  private async readRows(title: string): Promise<unknown[][]> {
    let column = this.table(title).columns.length;
    let lastColumn = '';
    while (column > 0) {
      lastColumn = String.fromCharCode(65 + (column - 1) % 26) + lastColumn;
      column = Math.floor((column - 1) / 26);
    }
    const { data } = await this.client.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `'${title}'!A2:${lastColumn}`, valueRenderOption: 'UNFORMATTED_VALUE' }, requestOptions);
    return data.values ?? [];
  }

  private async readUsers(): Promise<{ user: CurrentUser; rowIndex: number; values: unknown[] }[]> {
    return logOperation(this.logger, 'sheets_read_users', async () => {
      if (!this.tables.size) await this.initialize();
      const table = this.table('Users');
      const result: { user: CurrentUser; rowIndex: number; values: unknown[] }[] = [];
      const seen = new Set<string>();
      for (const [index, row] of (await this.readRows('Users')).entries()) {
        if (!row.some((v) => v !== '' && v !== null)) continue;
        const record: Record<string, string | null> = Object.fromEntries(table.columns.map((name, i) => [name, row[i] === undefined ? '' : String(row[i])]));
        record.username = record.username || null;
        const parsed = currentUserSchema.safeParse(record);
        if (!parsed.success || record.latitude === '' || record.longitude === '' || seen.has(parsed.data.user_id)) throw new Error('Некорректные или повторные записи Users');
        seen.add(parsed.data.user_id);
        result.push({ user: parsed.data, rowIndex: index + 1, values: row });
      }
      return result;
    }, 'debug');
  }

  async getUser(userId: string): Promise<CurrentUser | null> { return (await this.readUsers()).find(({ user }) => user.user_id === userId)?.user ?? null; }
  async listUsers(): Promise<CurrentUser[]> { return (await this.readUsers()).map(({ user }) => user); }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async saveLocation(user: CurrentUser, event: LocationHistoryEntry): Promise<void> {
    await logOperation(this.logger, 'sheets_save_location', () => this.locked(async () => {
      const existing = (await this.readUsers()).find((e) => e.user.user_id === user.user_id);
      const users = this.table('Users');
      const history = this.table('LocationHistory');
      const record: Record<string, unknown> = { ...user };
      const rows = [cells(users.columns.map((column, i) => column in record ? record[column] : existing?.values[i] ?? ''))];
      const writeUser: sheets_v4.Schema$Request = existing
        ? { updateCells: { start: { sheetId: users.id, rowIndex: existing.rowIndex, columnIndex: 0 }, rows, fields: 'userEnteredValue' } }
        : { appendCells: { sheetId: users.id, rows, fields: 'userEnteredValue' } };
      const historical: Record<string, unknown> = { ...event };
      await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [writeUser,
        { appendCells: { sheetId: history.id, rows: [cells(history.columns.map((c) => historical[c] ?? ''))], fields: 'userEnteredValue' } },
      ] } }, requestOptions);
    }));
  }

  async getSetting(key: string): Promise<string | null> {
    if (!this.tables.size) await this.initialize();
    const columns = this.table('Settings').columns;
    const rows = (await this.readRows('Settings')).filter((r) => r[columns.indexOf('key')] === key);
    if (rows.length > 1) throw new Error('Duplicate setting');
    const value = rows[0]?.[columns.indexOf('value')];
    return value === undefined || value === '' ? null : String(value);
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.locked(async () => {
      if (!this.tables.size) await this.initialize();
      const table = this.table('Settings');
      const rows = await this.readRows('Settings');
      const matches = rows.map((row, i) => ({ row, i })).filter(({ row }) => row[table.columns.indexOf('key')] === key);
      if (matches.length > 1) throw new Error('Duplicate setting');
      const existing = matches[0];
      const values = table.columns.map((c, i) => c === 'key' ? key : c === 'value' ? value : existing?.row[i] ?? '');
      const request: sheets_v4.Schema$Request = existing
        ? { updateCells: { start: { sheetId: table.id, rowIndex: existing.i + 1, columnIndex: 0 }, rows: [cells(values)], fields: 'userEnteredValue' } }
        : { appendCells: { sheetId: table.id, rows: [cells(values)], fields: 'userEnteredValue' } };
      await this.client.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests: [request] } }, requestOptions);
    });
  }
}
