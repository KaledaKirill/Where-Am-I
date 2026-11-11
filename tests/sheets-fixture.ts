import { vi } from 'vitest';
import type { sheets_v4 } from '@googleapis/sheets';
import { GoogleSheetsRepository } from '../src/adapters/google-sheets-repository.js';
import type { SheetsClient } from '../src/adapters/google-sheets-repository.js';

import { silentLogger } from '../src/logging.js';


export function fakeSheets(initial: Record<string, (string | number)[][]> = {}, logger = silentLogger) {
  const tables = new Map(Object.entries(structuredClone(initial)));
  const ids = new Map(Object.keys(initial).map((title, i) => [title, i]));
  const get = vi.fn(async () => ({ data: { sheets: [...ids].map(([title, sheetId]) => ({ properties: { title, sheetId } })) } }));
  const valuesGet = vi.fn(async ({ range }: { range: string }) => {
    const title = range.match(/^'([^']+)'/)?.[1] ?? '';
    const table = tables.get(title) ?? [];
    return { data: { values: range.endsWith('!1:1') ? table.slice(0, 1) : range.includes('!A2:') ? table.slice(1) : table } };
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
  return { repo, client, get, valuesGet, batchUpdate, tables };
}
