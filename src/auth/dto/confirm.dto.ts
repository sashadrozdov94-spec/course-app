import * as z from 'zod';

// Подтверждение кодом: какая попытка + сам код
export const confirmOtpSchema = z.object({
  attemptId: z.uuid('Некорректный идентификатор попытки'),
  code: z
    .string({ error: 'Укажите код из письма' })
    .trim()
    .regex(/^\d{4,10}$/, 'Код состоит только из цифр'),
});
export type ConfirmOtpDto = z.infer<typeof confirmOtpSchema>;

// Повторная отправка письма
export const resendSchema = z.object({
  attemptId: z.uuid('Некорректный идентификатор попытки'),
});
export type ResendDto = z.infer<typeof resendSchema>;

// Подтверждение по ссылке: токен из адреса
export const confirmLinkSchema = z.object({
  token: z.string({ error: 'Нет токена' }).min(10, 'Некорректный токен'),
});
export type ConfirmLinkDto = z.infer<typeof confirmLinkSchema>;
