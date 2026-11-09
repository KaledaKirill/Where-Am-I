import type { ResolvedPlace } from './models.js';

export interface PlaceResolver {
  resolve(input: string): Promise<ResolvedPlace[]>;
}
