import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'node:worker_threads';
import type { Env } from '../../config/env.schema.js';

/** Что вернул поток. */
export interface RunResult {
  ok: boolean;
  output?: string;
  error?: string;
  timedOut?: boolean;
}

/**
 * Запуск конвертации в отдельном потоке с таймаутом.
 *
 * Поток на задачу, без пула. Пул экономил бы миллисекунды на старте, но
 * добавил бы очередь, учёт занятых потоков и их переиспользование — а
 * заодно риск, что «отравленный» файл оставит поток в странном состоянии.
 * При лимите в несколько мегабайт запуск потока не является узким местом.
 */
@Injectable()
export class ConversionRunner {
  private readonly logger = new Logger('ConversionRunner');
  private readonly timeoutMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.timeoutMs = config.get('CONVERT_TIMEOUT_MS', { infer: true });
  }

  run(source: string, target: string, input: string): Promise<RunResult> {
    // Путь к собранному файлу потока рядом с этим модулем. import.meta.url
    // указывает в dist после сборки, поэтому расширение .js, а не .ts.
    const workerUrl = new URL('./convert.worker.js', import.meta.url);

    return new Promise<RunResult>((resolve) => {
      const worker = new Worker(workerUrl, {
        workerData: { source, target, input },
      });

      let settled = false;

      const finish = (result: RunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // terminate вместо ожидания: поток мог зависнуть, а нам он больше
        // не нужен ни в каком случае.
        void worker.terminate();
        resolve(result);
      };

      const timer = setTimeout(() => {
        this.logger.warn(
          `Конвертация ${source} → ${target} прервана по таймауту ${this.timeoutMs} мс`,
        );
        finish({
          ok: false,
          timedOut: true,
          error: 'Превышено время конвертации',
        });
      }, this.timeoutMs);

      worker.on('message', (result: RunResult) => finish(result));

      worker.on('error', (error: Error) => {
        // Сюда попадает и переполнение стека, и нехватка памяти — то есть
        // ровно то, ради чего поток и заводился: падает он, а не приложение.
        this.logger.error(`Поток конвертации упал: ${error.message}`);
        finish({ ok: false, error: 'Не удалось обработать файл' });
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          finish({ ok: false, error: 'Не удалось обработать файл' });
        }
      });
    });
  }
}
