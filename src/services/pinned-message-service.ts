import { GrammyError } from 'grammy';
import type { Api } from 'grammy';
import type { LocationRepository } from '../domain/location-repository.js';
import type { LocationService } from './location-service.js';
import { checkListLength, formatList } from '../bot/formatting.js';
import { safeError, silentLogger } from '../logging.js';
import type { AppLogger } from '../logging.js';

export class PinnedMessageService {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly repository: LocationRepository,
    private readonly service: LocationService,
    private readonly api: Pick<Api, 'sendMessage' | 'editMessageText' | 'pinChatMessage'>,
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
    const text = formatList(await this.service.listGroups());
    checkListLength(text);
    const stored = await this.repository.getSetting('pinned_message_id');
    const id = stored && /^[1-9]\d*$/.test(stored) ? Number(stored) : null;
    if (id && Number.isSafeInteger(id)) {
      try {
        await this.api.editMessageText(this.groupId, id, text, { parse_mode: 'HTML' });
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('message to edit not found')) {
          await this.create(text);
          return;
        }
        if (!(error instanceof GrammyError && error.error_code === 400 && error.description.toLowerCase().includes('message is not modified'))) throw error;
      }
      // Retrying this also repairs an interrupted pin after the ID was stored.
      await this.api.pinChatMessage(this.groupId, id, { disable_notification: true });
      return;
    }
    await this.create(text);
  }

  private async create(text: string): Promise<void> {
    const message = await this.api.sendMessage(this.groupId, text, { parse_mode: 'HTML' });
    // Persist before pinning so a missing permission cannot cause new messages
    // on every check-in. A later update can finish pinning this same message.
    await this.repository.setSetting('pinned_message_id', String(message.message_id));
    await this.api.pinChatMessage(this.groupId, message.message_id, { disable_notification: true });
  }
}
