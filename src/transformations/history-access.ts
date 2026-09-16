import type { RbacService } from '../rbac/rbac.service.js';
import type { User } from '../users/entities/user.entity.js';
import {
  TRANSFORMATIONS_ACTIONS,
  TRANSFORMATIONS_PERMISSION,
} from './transformation.js';

/**
 * Можно ли этому человеку смотреть историю того человека.
 *
 * Одно определение на оба сценария — список и скачивание файла. Правило
 * доступа, размноженное по сервисам, однажды разъедется: поправят в
 * одном месте, забудут в другом, и разойдутся они молча — тестом «список
 * не пускает» дыру в скачивании не поймать.
 *
 * Своё видно всегда: запрещать человеку его же записи было бы
 * произволом, эти же данные ему отдаёт соседнее окно.
 */
export function canReadHistoryOf(
  rbac: RbacService,
  actor: User,
  userId: string,
): Promise<boolean> | boolean {
  if (actor.id === userId) {
    return true;
  }

  return rbac.can(
    actor,
    TRANSFORMATIONS_PERMISSION,
    TRANSFORMATIONS_ACTIONS.HistoryAdmin,
  );
}
