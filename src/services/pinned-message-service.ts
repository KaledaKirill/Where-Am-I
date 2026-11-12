import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import type { LocationRepository } from '../domain/location-repository.js';
import type { LocationService } from './location-service.js';
import { formatListParts } from '../bot/formatting.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

export class PinnedMessageService {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly repository: LocationRepository,
    private readonly service: LocationService,
    private readonly api: Pick<Api, 'sendMessage' | 'editMessageText' | 'pinChatMessage' | 'unpinChatMessage'>,
    private readonly groupId: string,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async update(): Promise<void> {
    // Serialize creation and edits within this process; always re-read the list.
    const task = this.pending.then(() => this.refresh());
    this.pending = task.catch(() => {});
    try { await task; }
    catch (error) {
      this.logger.error({ event: 'pinned_message_update_failed', ...safeError(error) }, 'Не удалось обновить закреп. Сохранённые отметки остаются в таблице; следующая отметка повторит обновление.');
    }
  }

  private async refresh(): Promise<void> {
    const parts = formatListParts(await this.service.listGroups());
    const stored = await this.repository.getSetting('pinned_message_id');
    const first = stored && /^[1-9]\d*$/.test(stored) && Number.isSafeInteger(Number(stored)) ? Number(stored) : null;
    const extraStored = await this.repository.getSetting('pinned_message_ids');
    const extra: unknown = extraStored ? JSON.parse(extraStored) : [];
    if (!Array.isArray(extra) || extra.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set([first, ...extra].filter(Boolean)).size !== extra.length + (first ? 1 : 0)) throw new Error('Invalid pinned message IDs');
    const ids: (number | null)[] = [first, ...extra as number[]];
    for (const [index, text] of parts.entries()) {
      let id = ids[index];
      if (id) {
        try {
          await this.api.editMessageText(this.groupId, id, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        } catch (error) {
          if (error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('message to edit not found')) id = null;
          else if (!(error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('message is not modified'))) throw error;
        }
      }
      if (!id) {
        const message = await this.api.sendMessage(this.groupId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        id = message.message_id;
        ids[index] = id;
        // Store before pinning so retries repair the same known message.
        await this.repository.setSetting(index === 0 ? 'pinned_message_id' : 'pinned_message_ids', index === 0 ? String(id) : JSON.stringify(ids.slice(1)));
      }
      await this.api.pinChatMessage(this.groupId, id, { disable_notification: true });
    }
    while (ids.length > parts.length) {
      const id = ids.at(-1)!;
      try { await this.api.unpinChatMessage(this.groupId, id); }
      catch (error) {
        if (!(error instanceof GrammyError && error.error_code === 400 && /message (?:to unpin )?not found/i.test(error.description))) throw error;
      }
      ids.pop();
      await this.repository.setSetting('pinned_message_ids', JSON.stringify(ids.slice(1)));
    }
  }
}
