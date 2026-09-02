import * as z from 'zod';

// Бланк входа. Проверки мягче, чем при регистрации: политику пароля здесь
// применять нельзя — пароль мог быть создан по старым правилам.
export const loginSchema = z.object({
  email: z
    .string({ error: 'Укажите адрес почты' })
    .trim()
    .toLowerCase()
    .pipe(z.email('Введите настоящий адрес почты')),
  password: z.string({ error: 'Укажите пароль' }).min(1, 'Укажите пароль'),
});

export type LoginDto = z.infer<typeof loginSchema>;
