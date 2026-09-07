import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from './token.service.js';

/**
 * Маленькая коробка только с токенами.
 *
 * Зачем отдельно: охранник закрытых окон (JwtAuthGuard) нужен и коробке auth,
 * и коробке users. Если бы он лежал в auth, коробке users пришлось бы
 * импортировать auth — а auth уже импортирует users. Получилось бы кольцо,
 * и Nest не смог бы собрать приложение.
 *
 * TokenModule не зависит ни от кого, поэтому его может импортировать любой.
 */
@Module({
  // Секреты и сроки задаём в TokenService при каждой подписи,
  // поэтому здесь регистрируем JwtModule без общих настроек.
  imports: [JwtModule.register({})],
  providers: [TokenService],
  exports: [TokenService],
})
export class TokenModule {}
