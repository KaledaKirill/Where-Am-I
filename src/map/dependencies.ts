import { safeError } from '../logging.js';

type MapStage = 'viewer_membership' | 'participant_membership' | 'users_sheet' | 'history_sheet';
const transient = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);

class MapDependencyError extends Error {
  constructor(readonly stage: MapStage, readonly attempts: 1 | 2, cause: unknown) {
    super('map_dependency_unavailable', { cause });
  }
}

export async function readMapDependency<T>(stage: MapStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const info = safeError(error);
    const canRetry = transient.has(String(info.error_code)) || transient.has(String(info.cause_code))
      || info.error_type === 'TimeoutError' || [502, 503, 504].includes(Number(info.http_status));
    if (!canRetry) throw new MapDependencyError(stage, 1, error);
  }
  try { return await operation(); }
  catch (error) { throw new MapDependencyError(stage, 2, error); }
}

export function mapFailure(error: unknown) {
  return error instanceof MapDependencyError ? { stage: error.stage, attempts: error.attempts, ...safeError(error.cause) } : safeError(error);
}
