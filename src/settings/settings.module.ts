import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthSettingsService } from './auth-settings.service.js';
import { AuthSettings } from './entities/auth-settings.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([AuthSettings])],
  providers: [AuthSettingsService],
  exports: [AuthSettingsService],
})
export class SettingsModule {}
