import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FileFormat } from '../format.js';

/** Чем закончилась конвертация. */
export enum ConversionStatus {
  Success = 'success',
  Error = 'error',
}

/**
 * Таблица file_conversions — история всех трансформаций.
 *
 * Хранит то, что требует п. 1.5 ТЗ: кто, из какого формата в какой, размер
 * входа, результат и длительность. Плюс размер выхода и код ошибки — по
 * ним видно, что именно пошло не так, без чтения логов.
 *
 * Содержимого файлов здесь нет и быть не должно: ТЗ это запрещает прямо, и
 * это разумно — в конвертируемых данных бывает что угодно.
 *
 * Внешнего ключа на users намеренно нет: история должна пережить удаление
 * аккаунта, как и записи журналов auth и rbac.
 */
@Entity({ name: 'file_conversions' })
@Index(['userId', 'createdAt'])
export class FileConversion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Кто конвертировал. Привязка к пользователю, которую требует ТЗ. */
  @Column({ type: 'uuid' })
  userId: string;

  /** Имя исходного файла. Само имя — не содержимое, хранить его можно. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceName: string | null;

  @Column({ type: 'enum', enum: FileFormat })
  sourceFormat: FileFormat;

  @Column({ type: 'enum', enum: FileFormat })
  targetFormat: FileFormat;

  @Column({ type: 'int' })
  sourceBytes: number;

  /** null, если конвертация не дошла до результата. */
  @Column({ type: 'int', nullable: true })
  targetBytes: number | null;

  @Column({ type: 'enum', enum: ConversionStatus })
  status: ConversionStatus;

  /** Код ответа: 200, 400, 413, 415, 504. */
  @Column({ type: 'int' })
  statusCode: number;

  /** Короткая причина отказа. Без содержимого файла. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  error: string | null;

  /** Сколько заняла сама конвертация, миллисекунды. */
  @Column({ type: 'int' })
  durationMs: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
