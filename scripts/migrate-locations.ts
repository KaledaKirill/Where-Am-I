import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { sheets_v4 } from '@googleapis/sheets';
import { z } from 'zod';
import { cells, createSheetsClient, currentUserSchema, locatedSchema, requestOptions, TABLE_COLUMNS } from '../src/adapters/google-sheets-repository.js';
import type { SheetsClient } from '../src/adapters/google-sheets-repository.js';
import { GeoapifyGeocoder, GeocodingError } from '../src/adapters/geoapify-geocoder.js';
import type { ForwardGeocoder } from '../src/domain/geocoder.js';
import { locationLabel } from '../src/domain/geocoder.js';
import { loadConfig } from '../src/config.js';
import { safeError } from '../src/logging.js';

// One-off pre-deployment tool. Not imported by the application or CI.
export type Cell = string | number | boolean | null;
export interface Snapshot { sheets: { title: string; id: number; rows: Cell[][] }[] }
type Overrides = Record<string, string | null>;
interface Issue { sheet: string; row: number; original: string; normalized?: string; reason: string }
export interface MigrationPlan {
  tables: Record<string, Cell[][]>;
  report: { source: number; normalized: number; skipped: number; unrecognized: Issue[]; ambiguous: Issue[]; warnings: Issue[]; infrastructureErrors: number };
}

const aliases: Record<string, string> = {
  'спб': 'Санкт-Петербург, Россия', 'питер': 'Санкт-Петербург, Россия',
  'санкт-петербург': 'Санкт-Петербург, Россия', 'мск': 'Москва, Россия',
  'бали': 'Бали, Индонезия',
};

export function normalizeLegacyLocation(original: string, overrides: Overrides = {}): string | null {
  if (Object.hasOwn(overrides, original)) return overrides[original]?.trim() || null;
  let value = original.normalize('NFKC').trim();
  // Keep geographic qualifiers, remove only recognizable personal comments.
  value = value.replace(/\(([^()]*)\)/gu, (whole, inner: string) =>
    /^(впишу|впишусь|проездом|ненадолго|скоро|до\s+\d.*|с\s+\d.*)$/iu.test(inner.trim()) ? ' ' : whole);
  // Route annotations such as Самара (—>Челябинск), Россия have an explicit
  // destination; parentheses do not turn it into a personal comment.
  value = value.replace(/\(([^()]*(?:[-—–=]+\s*>|[→➜➡])[^()]*)\)/gu, '$1');
  value = value.split(/(?:[-—–=]+\s*>|[→➜➡])/u).at(-1)!.trim();
  value = value.replace(/\s+/gu, ' ').replace(/\s*[,;]+\s*/gu, ', ').replace(/^[,.;\s]+|[,.;\s]+$/gu, '');
  value = value.replace(/\s+(россия|беларусь|индонезия|германия)$/iu, ', $1');
  value = value.replace(/,\s*,/gu, ',');
  const alias = aliases[value.toLocaleLowerCase('ru').replace(/\.$/u, '')];
  if (alias) return alias;
  if (!value || !/\p{L}/u.test(value) || /[\p{Cc}<>/?|]|\s[-—–]\s/u.test(value)) return null;
  if (/[()]/u.test(value) && !/\([^()]*\b(?:region|state)\b[^()]*\)|\([^()]*(?:область|край|район|республика)[^()]*\)/iu.test(value)) return null;
  return value.split(',').map((part) => part.trim().split(' ').map((word) =>
    word ? word[0]!.toLocaleUpperCase('ru') + word.slice(1).toLocaleLowerCase('ru') : '',
  ).join(' ')).join(', ');
}

export async function readSnapshot(client: SheetsClient, spreadsheetId: string): Promise<Snapshot> {
  const { data } = await client.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' }, requestOptions);
  const snapshot: Snapshot = { sheets: [] };
  for (const sheet of data.sheets ?? []) {
    const title = sheet.properties?.title;
    const id = sheet.properties?.sheetId;
    if (!title || id === undefined || id === null) throw new Error('Invalid spreadsheet metadata');
    const { data: values } = await client.spreadsheets.values.get({
      spreadsheetId, range: `'${title.replace(/'/g, "''")}'`, valueRenderOption: 'FORMULA',
    }, requestOptions);
    snapshot.sheets.push({ title, id, rows: structuredClone(values.values ?? []) });
  }
  return snapshot;
}

export async function planMigration(snapshot: Snapshot, geocoder: ForwardGeocoder, overrides: Overrides = {}, pause: () => Promise<unknown> = () => delay(1_000)): Promise<MigrationPlan> {
  const plan: MigrationPlan = { tables: {}, report: { source: 0, normalized: 0, skipped: 0, unrecognized: [], ambiguous: [], warnings: [], infrastructureErrors: 0 } };
  let providerFailed = false;
  for (const title of ['Users', 'LocationHistory'] as const) {
    const source = snapshot.sheets.find((s) => s.title === title)?.rows ?? [];
    const headers = (source[0] ?? []).map(String);
    if (new Set(headers).size !== headers.length || headers.some((h) => !h)) throw new Error(`Invalid headers: ${title}`);
    const nonempty = source.slice(1).map((row, i) => ({ row, number: i + 2 })).filter(({ row }) => row.some((v) => v !== null && v !== ''));
    if (nonempty.length && (!headers.includes('user_id') || !headers.includes(title === 'Users' ? 'updated_at' : 'recorded_at') || (!headers.includes('location') && !headers.includes('country')))) {
      throw new Error(`Unsupported schema: ${title}. Map headers explicitly before migration.`);
    }
    const columns = [...TABLE_COLUMNS[title], ...headers.filter((h) => !(TABLE_COLUMNS[title] as readonly string[]).includes(h)), ...(!headers.includes('legacy_location') ? ['legacy_location'] : [])];
    const output: Cell[][] = [columns];
    plan.tables[title] = output;
    const ids = nonempty.map(({ row }) => String(row[headers.indexOf('user_id')] ?? ''));
    const duplicates = new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
    for (const { row, number } of nonempty) {
      plan.report.source++;
      const record = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']));
      const original = String(record.location || [record.city || record.region, record.country].filter(Boolean).join(', '));
      const issue: Issue = { sheet: title, row: number, original, reason: '' };
      const skip = (reason: string, ambiguous = false) => {
        plan.report.skipped++;
        (ambiguous ? plan.report.ambiguous : plan.report.unrecognized).push({ ...issue, reason });
      };
      const userId = String(record.user_id ?? '');
      if (!/^\d+$/.test(userId)) { skip('invalid_user_id'); continue; }
      if (title === 'Users' && duplicates.has(userId)) { skip('duplicate_user_id', true); continue; }
      const timeColumn = title === 'Users' ? 'updated_at' : 'recorded_at';
      const timestamp = String(record[timeColumn] ?? '');
      if (!z.iso.datetime({ offset: true }).safeParse(timestamp).success) {
        if (title === 'Users') { skip('missing_or_invalid_original_date'); continue; }
        // An existing history event is real even if its date was never recorded.
        // Keep the original value, never synthesize a timestamp.
        plan.report.warnings.push({ ...issue, reason: 'original_history_date_missing_or_unparseable' });
      }
      if (title === 'Users' && !String(record.display_name ?? '').trim()) { skip('missing_display_name'); continue; }
      // Already migrated records keep their original coordinates and provenance.
      const existing = locatedSchema.safeParse(record);
      let location;
      if (existing.success && record.latitude !== '' && record.longitude !== '') location = existing.data;
      else {
        const query = normalizeLegacyLocation(original, overrides);
        if (!query) { skip('unrecognized_or_needs_override', true); continue; }
        issue.normalized = query;
        if (providerFailed) { skip('provider_stopped'); continue; }
        try {
          await pause();
          const resolved = await geocoder.forward(query);
          location = { ...resolved, location: locationLabel(resolved), coordinate_source: 'geocoded' as const };
          if (!locatedSchema.safeParse(location).success) throw new Error('Invalid geocoder response');
        } catch (error) {
          if (error instanceof GeocodingError && error.reason !== 'http') skip(error.reason, error.reason === 'ambiguous');
          else {
            providerFailed = true;
            plan.report.infrastructureErrors++;
            skip(error instanceof GeocodingError && error.status === 429 ? 'rate_limited' : 'provider_failed');
          }
          continue;
        }
      }
      const converted: Record<string, Cell> = { ...record, ...location, user_id: userId, [timeColumn]: timestamp, legacy_location: record.legacy_location || original };
      if (title === 'Users' && !currentUserSchema.safeParse({ ...converted, username: converted.username || null }).success) { skip('invalid_user_record'); continue; }
      output.push(columns.map((c) => (converted as Record<string, Cell>)[c] ?? ''));
      plan.report.normalized++;
    }
  }
  // Preserve existing settings and unrelated sheets; Places is no longer used.
  const settings = snapshot.sheets.find((s) => s.title === 'Settings')?.rows;
  if (settings?.length && (settings[0]?.[0] !== 'key' || settings[0]?.[1] !== 'value')) throw new Error('Unsupported Settings schema');
  plan.tables.Settings = settings?.length ? settings : [['key', 'value']];
  return plan;
}

export async function applyMigration(client: SheetsClient, spreadsheetId: string, snapshot: Snapshot, plan: MigrationPlan): Promise<void> {
  if (plan.report.infrastructureErrors) throw new Error('Provider failed; apply refused');
  if (JSON.stringify(await readSnapshot(client, spreadsheetId)) !== JSON.stringify(snapshot)) throw new Error('Spreadsheet changed since backup; apply refused');
  const requests: sheets_v4.Schema$Request[] = [];
  let nextId = Math.max(0, ...snapshot.sheets.map((s) => s.id)) + 1;
  for (const [title, rows] of Object.entries(plan.tables)) {
    const existing = snapshot.sheets.find((s) => s.title === title);
    const id = existing?.id ?? nextId++;
    if (!existing) requests.push({ addSheet: { properties: { title, sheetId: id } } });
    // Grow to fit; never shrink an existing grid or remove extra columns.
    requests.push({ appendDimension: { sheetId: id, dimension: 'COLUMNS', length: rows[0]!.length } });
    requests.push({ appendDimension: { sheetId: id, dimension: 'ROWS', length: rows.length } });
    requests.push({ updateCells: { range: { sheetId: id }, rows: rows.map(cells), fields: 'userEnteredValue' } });
  }
  await client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, requestOptions);
}

export async function runMigration(options: {
  client: SheetsClient; spreadsheetId: string; geocoder: ForwardGeocoder; apply?: boolean; overrides?: Overrides;
  saveArtifact: (name: string, value: unknown) => Promise<void>; pause?: () => Promise<unknown>;
}): Promise<MigrationPlan> {
  const snapshot = await readSnapshot(options.client, options.spreadsheetId);
  // A failed backup stops before geocoding and before any writes.
  await options.saveArtifact('backup.json', snapshot);
  const plan = await planMigration(snapshot, options.geocoder, options.overrides, options.pause);
  await options.saveArtifact('report.json', plan.report);
  await options.saveArtifact('preview.json', plan.tables);
  if (options.apply) await applyMigration(options.client, options.spreadsheetId, snapshot, plan);
  return plan;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg) && !arg.startsWith('--overrides=')) || (args.includes('--apply') && args.includes('--dry-run'))) throw new Error('Use --dry-run OR --apply, optionally --overrides=path.json');
  const config = loadConfig();
  const overridesPath = args.find((arg) => arg.startsWith('--overrides='))?.slice('--overrides='.length);
  const overrides = overridesPath ? z.record(z.string(), z.string().nullable()).parse(JSON.parse((await readFile(overridesPath, 'utf8')).replace(/^\uFEFF/u, ''))) : {};
  const directory = resolve('migration-artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(directory, { recursive: true });
  const plan = await runMigration({
    client: createSheetsClient(config), spreadsheetId: config.GOOGLE_SPREADSHEET_ID,
    geocoder: new GeoapifyGeocoder(config.GEOAPIFY_API_KEY), apply: args.includes('--apply'), overrides,
    saveArtifact: (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  });
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', source: plan.report.source, normalized: plan.report.normalized, skipped: plan.report.skipped, infrastructureErrors: plan.report.infrastructureErrors, artifacts: directory }));
  if (plan.report.infrastructureErrors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(JSON.stringify({ event: 'migration_failed', ...safeError(error) })); process.exitCode = 1; });
}
