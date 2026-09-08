import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserStatus } from './entities/user.entity.js';

// Всё общение с таблицей users идёт через этот сервис.
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  // Есть ли уже такой пользователь. Возвращает null, если нет.
  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  // Отпечаток пароля скрыт от обычных выборок, поэтому просим его отдельно.
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
      },
    });
  }

  // Найти по номеру. null, если такого пользователя нет.
  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Найти по номеру вместе с ролями.
   *
   * Отдельным методом, а не «всегда с ролями»: связка стоит лишнего JOIN,
   * и большинству мест роли не нужны. Нужны они охраннику JwtAuthGuard —
   * он кладёт пользователя в запрос, а из запроса его берёт проверка прав.
   */
  findByIdWithRoles(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      relations: { roles: true },
    });
  }

  // Найти по номеру. Бросает ошибку, если такого нет.
  async findByIdOrFail(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    return user;
  }

  // Почта подтверждена: ставим дату и делаем аккаунт рабочим.
  async markEmailVerified(id: string): Promise<User> {
    await this.usersRepository.update(
      { id },
      { emailVerifiedAt: new Date(), status: UserStatus.Active },
    );

    return this.findByIdOrFail(id);
  }

  /**
   * Меняет колонки профиля. Возвращает, сколько строк изменилось:
   * ноль — значит такого пользователя нет.
   *
   * Один запрос вместо «прочитать, изменить, сохранить»: так требование
   * 1.6 ТЗ про минимум обращений выполняется само собой, а заодно между
   * чтением и записью никто не успеет вклиниться.
   */
  async updateProfile(
    id: string,
    changes: Partial<
      Pick<User, 'avatarUrl' | 'status' | 'email' | 'emailVerifiedAt'>
    >,
  ): Promise<number> {
    const result = await this.usersRepository.update({ id }, changes);
    return result.affected ?? 0;
  }

  /**
   * Отметить вход. Вызывается только там, где человек действительно
   * вошёл, — при обновлении токенов не вызывается: refresh это не вход,
   * а продление уже выданного доступа.
   */
  async markLoggedIn(id: string): Promise<void> {
    await this.usersRepository.update({ id }, { lastLoginAt: new Date() });
  }

  /**
   * Удаляет пользователя. Возвращает, сколько строк удалилось: ноль —
   * значит его уже нет, и это не ошибка, а идемпотентность (п. 1.6 ТЗ).
   *
   * Коды подтверждения и связка с ролями уходят каскадом — так объявлены
   * внешние ключи. Записи журналов остаются: ссылка на пользователя там
   * без внешнего ключа, и это намеренно — история не должна исчезать
   * вместе с тем, о ком она.
   */
  async deleteById(id: string): Promise<number> {
    const result = await this.usersRepository.delete({ id });
    return result.affected ?? 0;
  }

  // Создаёт пользователя. Пароль сюда приходит уже в виде отпечатка.
  create(data: {
    email: string;
    passwordHash: string;
    status: UserStatus;
    emailVerifiedAt: Date | null;
  }): Promise<User> {
    const user = this.usersRepository.create(data);
    return this.usersRepository.save(user);
  }
}
