import {
  Injectable,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { FileStorage } from '../storage/file-storage.js';
import { Transformation } from './entities/transformation.entity.js';
import {
  TransformationStatus,
  type TransformationType,
  UNKNOWN_FORMAT,
} from './transformation.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Результат, который просили сохранить.
 *
 * Приходит вместе с записью, а не отдельным вызовом: файл и строка
 * истории — одно событие, и разводить их по двум вызовам значило бы
 * оставить между ними щель, в которой файл уже есть, а записи о нём ещё
 * нет (или наоборот).
 */
export interface SavedResult {
  body: Buffer;
  /** Имя для Content-Disposition. Собирает его модуль конвертации. */
  name: string;
  mime: string;
  /** Расширение для имени файла в хранилище. */
  extension: string;
}

/**
 * Одна выполненная трансформация — то, что о ней сообщает модуль.
 *
 * Длительность считается не здесь, а от момента, который знает только сам
 * модуль: началом считается приём файла, а не запись в базу.
 */
export interface TransformationRecord {
  userId: string;
  type: TransformationType;
  sourceName?: string | null;
  /** null — формат определить не удалось; ляжет как 'unknown'. */
  sourceFormat: string | null;
  targetFormat: string;
  fileSize: number;
  resultSize?: number;
  /** Код ответа: 200 — успех, всё остальное — отказ. */
  statusCode: number;
  /** Момент начала операции, Date.now(). */
  startedAt: number;
  error?: string;
  /** Что сохранить в хранилище. Отсутствует — сохранять нечего. */
  save?: SavedResult;
}

/**
 * Запись истории трансформаций и сохранение результатов (п. 1.5 ТЗ).
 *
 * Отдельный сервис на запись, отдельный на чтение — как у профиля
 * (profile-read / profile-write). Дело не в симметрии: пишут сюда два
 * модуля из середины своей работы, а читает административное окно со
 * своими правами и фильтрами. Общий класс тянул бы в конвертацию и права,
 * и пагинацию, которые ей не нужны.
 *
 * Пишем и успех, и отказ: по одним успешным записям не видно, что кто-то
 * систематически шлёт битые файлы или подбирает лимиты.
 */
@Injectable()
export class HistoryWriteService {
  private readonly logger = new Logger('Transformations');
  private readonly maxSaveBytes: number;
  private readonly retentionDays: number;

  constructor(
    @InjectRepository(Transformation)
    private readonly history: Repository<Transformation>,
    private readonly storage: FileStorage,
    config: ConfigService<Env, true>,
  ) {
    this.maxSaveBytes = config.get('TRANSFORMATION_MAX_SAVE_BYTES', {
      infer: true,
    });
    this.retentionDays = config.get('TRANSFORMATION_HISTORY_RETENTION_DAYS', {
      infer: true,
    });
  }

  /**
   * Сохранить результат (если просили) и записать строку истории.
   *
   * Порядок — файл, потом строка, и он не случаен. Строка с ключом файла,
   * которого нет, — это обещание, которое мы не сдержим: человек увидит в
   * истории кнопку «скачать» и получит отказ. Файл без строки — просто
   * мусор на диске, и он никому не мешает. Из двух рассогласований
   * выбираем то, которое не видно пользователю; а если строка всё-таки не
   * записалась, файл убираем следом.
   *
   * Про ошибки. Строку истории потерять не страшно — работа уже сделана,
   * файл человек получит, а о потере скажет журнал. Несохранённый файл —
   * другое дело: о нём просили явно, и молчать нельзя, поэтому такие
   * ошибки летят наружу (п. 1.4 ТЗ требует на них 500).
   */
  async record(entry: TransformationRecord): Promise<void> {
    const durationMs = Date.now() - entry.startedAt;
    const ok = entry.statusCode === 200;
    const sourceFormat = entry.sourceFormat ?? UNKNOWN_FORMAT;

    this.logger.log(
      `user=${entry.userId} ${entry.type} ${sourceFormat} → ${entry.targetFormat} ` +
        `${entry.fileSize} байт → ${entry.statusCode} за ${durationMs} мс` +
        (entry.resultSize === undefined ? '' : ` (${entry.resultSize} байт)`) +
        (entry.save ? ' save' : '') +
        (entry.error ? ` (${entry.error})` : ''),
    );

    // Сохраняем только удачные результаты: у отказа сохранять нечего, и
    // запрашивать save вместе с битым файлом — не повод что-то класть
    const stored = ok && entry.save ? await this.store(entry) : null;

    try {
      await this.history.save(
        this.history.create({
          userId: entry.userId,
          type: entry.type,
          sourceName: entry.sourceName?.slice(0, 255) ?? null,
          sourceFormat,
          targetFormat: entry.targetFormat.slice(0, 16),
          status: ok
            ? TransformationStatus.Success
            : TransformationStatus.Error,
          statusCode: entry.statusCode,
          fileSize: entry.fileSize,
          resultSize: entry.resultSize ?? null,
          error: entry.error?.slice(0, 255) ?? null,
          durationMs,
          fileId: stored?.fileId ?? null,
          resultName: stored ? entry.save!.name.slice(0, 255) : null,
          resultMime: stored ? entry.save!.mime.slice(0, 128) : null,
          expiresAt: stored?.expiresAt ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(`Не удалось записать историю трансформации: ${error}`);

      // Файл без строки истории не найти и не удалить штатной уборкой —
      // он останется на диске навсегда. Убираем сразу
      if (stored) {
        await this.storage
          .remove(stored.fileId)
          .catch((cleanupError: unknown) =>
            this.logger.error(
              `Осиротевший файл ${stored.fileId} не удалось убрать: ${cleanupError}`,
            ),
          );
      }
    }
  }

  /**
   * Положить результат в хранилище.
   *
   * Лимит проверяем до записи, а не после: смысл лимита в том, чтобы не
   * занять диск, и «сначала запишем, потом проверим» этот смысл теряет.
   */
  private async store(
    entry: TransformationRecord,
  ): Promise<{ fileId: string; expiresAt: Date | null }> {
    const result = entry.save!;
    const startedAt = Date.now();

    if (result.body.byteLength > this.maxSaveBytes) {
      throw new PayloadTooLargeException(
        `Результат ${result.body.byteLength} байт больше допустимых ` +
          `${this.maxSaveBytes} для сохранения. Повторите запрос без save, ` +
          'чтобы получить файл без сохранения в истории',
      );
    }

    try {
      const fileId = await this.storage.put(result.body, result.extension);

      this.logger.log(
        `user=${entry.userId} save ${fileId} ${result.body.byteLength} байт ` +
          `за ${Date.now() - startedAt} мс`,
      );

      return { fileId, expiresAt: this.expiryFor() };
    } catch (error) {
      this.logger.error(`Не удалось сохранить результат: ${error}`);

      // Наружу — общими словами: пути и коды ошибок файловой системы
      // клиенту ничего не подскажут, а нам покажут больше устройства
      // приложения, чем стоило бы
      throw new InternalServerErrorException(
        'Не удалось сохранить результат в хранилище',
      );
    }
  }

  /**
   * До какого момента жить файлу.
   *
   * Ровно столько же, сколько записи истории, — этого требует ТЗ. null
   * означает «бессрочно» и появляется, когда уборка отключена: срок
   * истечения без уборки был бы обещанием, которое некому исполнить.
   */
  private expiryFor(): Date | null {
    return this.retentionDays === 0
      ? null
      : new Date(Date.now() + this.retentionDays * DAY_MS);
  }
}
