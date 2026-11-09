import { createLogger } from '../src/logging.js';

export function captureLogs(level = 'debug') {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger(level, { write(line: string) { records.push(JSON.parse(line) as Record<string, unknown>); } });
  return { logger, records, output: () => JSON.stringify(records) };
}
