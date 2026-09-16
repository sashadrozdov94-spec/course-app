import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { FileStorage } from '../storage/file-storage.js';
import { Transformation } from './entities/transformation.entity.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Сколько записей убирать за один заход.
 *
 * Уборка ходит в хранилище за каждым файлом, а это не бесплатно. Брать
 * всё просроченное разом означало бы на запущенной базе выбрать миллион
 * строк в память и надолго занять диск; порциями — та же работа, но
 * приложение между порциями продолжает отвечать.
 */
const BATCH = 500;

/**
 * Срок хранения истории и сохранённых файлов (п. 1.6 ТЗ).
 *
 * История растёт линейно и не перестаёт: у активного пользователя это
 * сотни строк в день, а теперь ещё и файлы. Без срока и таблица, и диск
 * живут вечно. Заодно это ответ на вопрос «зачем нам знать, что человек
 * делал два года назад» — незачем, и хранить такое хуже, чем не хранить.
 *
 * Сколько именно хранить, решает администратор
 * (TRANSFORMATION_HISTORY_RETENTION_DAYS); значение 0 отключает уборку
 * совсем — бывает, что срок хранения диктует регламент снаружи.
 *
 * Уборка своя, без планировщика: @nestjs/schedule ради одной задачи раз в
 * сутки тянуть незачем. Первый проход — при старте, дальше по таймеру.
 * Таймер помечен unref, иначе процесс не завершился бы по SIGTERM: Node
 * ждёт все живые таймеры, а этому ждать нечего.
 */
@Injectable()
export class HistoryRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TransformationRetention');
  private readonly retentionDays: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Transformation)
    private readonly history: Repository<Transformation>,
    private readonly storage: FileStorage,
    config: ConfigService<Env, true>,
  ) {
    this.retentionDays = config.get('TRANSFORMATION_HISTORY_RETENTION_DAYS', {
      infer: true,
    });
    this.intervalMs =
      config.get('TRANSFORMATION_HISTORY_CLEANUP_HOURS', { infer: true }) *
      HOUR_MS;
  }

  onModuleInit(): void {
    if (this.retentionDays === 0) {
      this.logger.log('Срок хранения не задан: история и файлы не удаляются');
      return;
    }

    // Первый проход не ждёт сутки: приложение могло простоять неделю, и
    // просроченное лучше убрать сразу, а не после первого срабатывания
    void this.purge();

    this.timer = setInterval(() => void this.purge(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Удалить всё, что старше срока, вместе с файлами.
   *
   * Порядок — файл, потом строка. Строка без файла честно отвечает «файл
   * недоступен», а файл без строки не найти и не удалить уже никогда: в
   * базе про него ничего нет. Из двух возможных рассогласований выбираем
   * то, которое самоисправляется на следующем заходе.
   *
   * Ошибку ловим и продолжаем жить: недоступная на минуту база или диск —
   * не повод ронять приложение, а просроченное подождёт следующего
   * прохода. Именно поэтому уборка и повторяемая: второй заход по уже
   * удалённому файлу проходит спокойно.
   */
  async purge(): Promise<number> {
    const before = new Date(Date.now() - this.retentionDays * DAY_MS);
    let removed = 0;

    try {
      // Порциями, пока не кончится просроченное. Ограничитель на случай
      // ошибки в условии: бесконечный цикл в фоне хуже недоубранной истории
      for (let pass = 0; pass < 1000; pass += 1) {
        const batch = await this.history.find({
          where: { createdAt: LessThan(before) },
          select: { id: true, fileId: true },
          order: { createdAt: 'ASC' },
          take: BATCH,
        });

        if (batch.length === 0) {
          break;
        }

        const cleared = await this.removeFiles(batch);

        // Строки, чьи файлы убрать не удалось, оставляем: удалить их
        // сейчас значило бы навсегда потерять след файла — в базе про
        // него больше ничего нет, и с диска его уже никто не уберёт
        if (cleared.length === 0) {
          break;
        }

        await this.history.delete({ id: In(cleared) });
        removed += cleared.length;

        if (batch.length < BATCH) {
          break;
        }
      }

      if (removed > 0) {
        this.logger.log(
          `Удалено записей истории старше ${this.retentionDays} дней: ${removed}`,
        );
      }

      return removed;
    } catch (error) {
      this.logger.error(`Не удалось убрать старую историю: ${error}`);
      return removed;
    }
  }

  /**
   * Убрать файлы порции. Возвращает записи, которые теперь можно удалять.
   *
   * Сбой на одном файле не останавливает уборку остальных: место на диске
   * нужно освободить, а застрявшая запись остаётся в базе и попадёт в
   * следующий заход — она всё ещё просрочена. Так у файла сохраняется
   * хоть какой-то след, по которому его однажды уберут.
   */
  private async removeFiles(
    batch: { id: string; fileId: string | null }[],
  ): Promise<string[]> {
    const cleared: string[] = [];

    for (const row of batch) {
      if (!row.fileId) {
        cleared.push(row.id);
        continue;
      }

      try {
        await this.storage.remove(row.fileId);
        cleared.push(row.id);
      } catch (error) {
        this.logger.error(
          `Файл ${row.fileId} записи ${row.id} не удалось убрать: ${error}`,
        );
      }
    }

    return cleared;
  }
}
