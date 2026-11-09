import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { LocationRepository } from '../domain/location-repository.js';
import type { CurrentUser, LocationHistoryEntry } from '../domain/models.js';
import { logOperation, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

export const USER_COLUMNS = ['user_id', 'display_name', 'username', 'place_key', 'city', 'region', 'country', 'country_code', 'latitude', 'longitude', 'updated_at'] as const;
export const HISTORY_COLUMNS = ['user_id', 'place_key', 'city', 'region', 'country', 'country_code', 'latitude', 'longitude', 'recorded_at'] as const;
export type SheetsClient = Pick<sheets_v4.Sheets, 'spreadsheets'>;
const requestOptions = { retry: false, timeout: 10_000 };

const currentUserSchema = z.object({
  user_id: z.string().regex(/^\d+$/), display_name: z.string().min(1),
  username: z.string().nullable(), place_key: z.string().min(1), city: z.string().min(1),
  region: z.string().nullable(), country: z.string().min(1), country_code: z.string().regex(/^[A-Z]{2}$/),
  latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180),
  updated_at: z.iso.datetime(),
});

function cells(values: (string | number | null)[]): sheets_v4.Schema$RowData {
  return { values: values.map((value) => ({
    userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value ?? '' },
  })) };
}

export function createGoogleSheetsRepository(config: Config, logger: AppLogger = silentLogger): GoogleSheetsRepository {
  const auth = new GoogleAuth({
    credentials: {
      client_email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return new GoogleSheetsRepository(sheets({ version: 'v4', auth }), config.GOOGLE_SPREADSHEET_ID, logger);
}

export class GoogleSheetsRepository implements LocationRepository {
  private userSheetId: number | undefined;
  private historySheetId: number | undefined;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly client: SheetsClient, private readonly spreadsheetId: string, private readonly logger: AppLogger = silentLogger) {}

  async initialize(): Promise<void> {
    return logOperation(this.logger, 'sheets_initialize', () => this.initializeSheets());
  }

  private async initializeSheets(): Promise<void> {
    const { data } = await this.client.spreadsheets.get({
      spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(sheetId,title)',
    }, requestOptions);
    const existing = new Map((data.sheets ?? []).map((sheet) => [sheet.properties?.title, sheet.properties?.sheetId]));
    let nextId = Math.max(0, ...[...existing.values()].map((id) => id ?? 0)) + 1;
    const requests: sheets_v4.Schema$Request[] = [];
    const ids = new Map<string, number>();
    // Validate every existing header before applying any initialization changes.
    for (const [title, columns] of [['Users', USER_COLUMNS], ['LocationHistory', HISTORY_COLUMNS]] as const) {
      const id = existing.get(title) ?? nextId++;
      ids.set(title, id);
      let needsHeader = true;
      if (existing.has(title)) {
        const header = await this.client.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId, range: `'${title}'!1:1`, valueRenderOption: 'UNFORMATTED_VALUE',
        }, requestOptions);
        const row = header.data.values?.[0] ?? [];
        if (row.length) {
          if (row.length !== columns.length || columns.some((name, index) => row[index] !== name)) {
            throw new Error(`Несовместимые заголовки листа ${title}; требуется ручная проверка.`);
          }
          needsHeader = false;
        } else {
          const content = await this.client.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId, range: `'${title}'`, valueRenderOption: 'UNFORMATTED_VALUE',
          }, requestOptions);
          if (content.data.values?.some((row) => row.some((cell) => cell !== '' && cell !== null))) {
            throw new Error(`Лист ${title} содержит данные без заголовков; требуется ручная проверка.`);
          }
        }
      } else {
        requests.push({ addSheet: { properties: { sheetId: id, title } } });
      }
      if (needsHeader) requests.push({ updateCells: {
        start: { sheetId: id, rowIndex: 0, columnIndex: 0 }, rows: [cells([...columns])], fields: 'userEnteredValue',
      } });
    }
    if (requests.length) await this.client.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId, requestBody: { requests },
    }, requestOptions);
    this.userSheetId = ids.get('Users')!;
    this.historySheetId = ids.get('LocationHistory')!;
    this.logger.info({ event: 'sheets_schema_ready', created_sheets: [...ids.keys()].filter((title) => !existing.has(title)), initialized: true });
  }

  private assertInitialized(): void {
    if (this.userSheetId === undefined || this.historySheetId === undefined) throw new Error('Repository не инициализирован');
  }

  private async readUsers(): Promise<{ user: CurrentUser; rowIndex: number }[]> {
    return logOperation(this.logger, 'sheets_read_users', () => this.readUserRows(), 'debug');
  }

  private async readUserRows(): Promise<{ user: CurrentUser; rowIndex: number }[]> {
    this.assertInitialized();
    const { data } = await this.client.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId, range: "'Users'!A2:K", valueRenderOption: 'UNFORMATTED_VALUE',
    }, requestOptions);
    const result: { user: CurrentUser; rowIndex: number }[] = [];
    const seen = new Set<string>();
    for (const [index, row] of (data.values ?? []).entries()) {
      if (!row.some((value) => value !== '' && value !== null)) continue;
      const record = Object.fromEntries(USER_COLUMNS.map((name, i) => [name, row[i] ?? '']));
      record.username = record.username === '' ? null : record.username;
      record.region = record.region === '' ? null : record.region;
      const parsed = currentUserSchema.safeParse(record);
      if (!parsed.success || seen.has(parsed.data.user_id)) throw new Error('Некорректные или повторные записи Users');
      seen.add(parsed.data.user_id);
      result.push({ user: parsed.data, rowIndex: index + 1 });
    }
    return result;
  }

  async getUser(userId: string): Promise<CurrentUser | null> {
    return (await this.readUsers()).find(({ user }) => user.user_id === userId)?.user ?? null;
  }

  async listUsers(): Promise<CurrentUser[]> {
    return (await this.readUsers()).map(({ user }) => user);
  }

  async saveLocation(user: CurrentUser, event: LocationHistoryEntry): Promise<void> {
    return logOperation(this.logger, 'sheets_save_location', () => this.saveLocationLocked(user, event));
  }

  private async saveLocationLocked(user: CurrentUser, event: LocationHistoryEntry): Promise<void> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const users = await this.readUsers();
      const existing = users.find((entry) => entry.user.user_id === user.user_id);
      const userRows = [cells(USER_COLUMNS.map((column) => user[column]))];
      const writeUser: sheets_v4.Schema$Request = existing
        ? { updateCells: {
          start: { sheetId: this.userSheetId, rowIndex: existing.rowIndex, columnIndex: 0 },
          rows: userRows, fields: 'userEnteredValue',
        } }
        : { appendCells: { sheetId: this.userSheetId, rows: userRows, fields: 'userEnteredValue' } };
      await this.client.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [writeUser, { appendCells: {
          sheetId: this.historySheetId,
          rows: [cells(HISTORY_COLUMNS.map((column) => event[column]))], fields: 'userEnteredValue',
        } }] },
      }, requestOptions);
    } finally { release(); }
  }
}
