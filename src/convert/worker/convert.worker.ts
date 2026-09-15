import { parentPort, workerData } from 'node:worker_threads';
import { findConverter } from '../converters/index.js';

/**
 * Рабочий поток конвертации.
 *
 * Зачем отдельный поток (п. 1.6 ТЗ): разбор JSON и XML — работа, которая
 * целиком занимает процессор и не отдаёт управление. В основном потоке
 * файл на несколько мегабайт заморозил бы всё приложение: пока он
 * разбирается, никто не войдёт и не откроет профиль.
 *
 * Второе, не менее важное: только так работает таймаут. Прервать
 * JSON.parse в своём же потоке нечем — цикл событий занят, и любой
 * setTimeout сработает уже после. Поток можно просто убить.
 *
 * Внутри — никакого Nest: контейнер живёт в основном потоке. Конвертеры
 * поэтому и сделаны обычными классами без зависимостей.
 */

interface Task {
  source: string;
  target: string;
  input: string;
}

interface Result {
  ok: boolean;
  output?: string;
  error?: string;
}

function run(task: Task): Result {
  const converter = findConverter(task.source, task.target);

  if (!converter) {
    return {
      ok: false,
      error: `Направление ${task.source} → ${task.target} не поддерживается`,
    };
  }

  try {
    return { ok: true, output: converter.convert(task.input) };
  } catch (error) {
    // Наружу отдаём только текст ошибки: объект Error между потоками
    // передаётся плохо, а стек вызывающей стороне не нужен.
    return { ok: false, error: (error as Error).message };
  }
}

parentPort?.postMessage(run(workerData as Task));
