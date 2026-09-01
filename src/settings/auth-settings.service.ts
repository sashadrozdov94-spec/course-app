import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthSettings } from './entities/auth-settings.entity.js';

// В таблице всегда одна строка, её id
const SETTINGS_ID = 1;

@Injectable()
export class AuthSettingsService implements OnModuleInit {
  private readonly logger = new Logger(AuthSettingsService.name);

  constructor(
    @InjectRepository(AuthSettings)
    private readonly repository: Repository<AuthSettings>,
  ) {}

  // При запуске приложения создаём строку настроек, если её ещё нет.
  async onModuleInit(): Promise<void> {
    const existing = await this.repository.findOne({
      where: { id: SETTINGS_ID },
    });

    if (!existing) {
      await this.repository.save(this.repository.create({ id: SETTINGS_ID }));
      this.logger.log('Созданы настройки по умолчанию');
    }
  }

  // Прочитать настройки. Читаем из базы каждый раз, поэтому изменения
  // применяются сразу, без перезапуска приложения.
  async get(): Promise<AuthSettings> {
    const settings = await this.repository.findOne({
      where: { id: SETTINGS_ID },
    });

    if (!settings) {
      // Такого быть не должно, но если строку удалили руками — создадим заново.
      return this.repository.save(this.repository.create({ id: SETTINGS_ID }));
    }

    return settings;
  }

  // Изменить настройки (частично: меняем только присланные поля).
  async update(changes: Partial<AuthSettings>): Promise<AuthSettings> {
    await this.repository.update({ id: SETTINGS_ID }, changes);
    this.logger.log(`Настройки изменены: ${Object.keys(changes).join(', ')}`);
    return this.get();
  }
}
