import { Module } from '@nestjs/common';
import { DiskFileStorage } from './disk-file-storage.js';
import { FileStorage } from './file-storage.js';

/**
 * Хранилище файлов приложения.
 *
 * Провайдер объявлен через useClass: снаружи просят FileStorage — общее
 * понятие, — а какой он на самом деле, решается здесь, в одной строке.
 * Поэтому ни конвертация, ни история, ни уборка не знают, что файлы лежат
 * на диске: им это и не нужно.
 *
 * Реализация сейчас одна — DiskFileStorage. Появится другая, и поменяется
 * ровно эта строка.
 */
@Module({
  providers: [{ provide: FileStorage, useClass: DiskFileStorage }],
  exports: [FileStorage],
})
export class StorageModule {}
