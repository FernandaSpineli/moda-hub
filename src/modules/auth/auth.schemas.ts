import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('must be a valid email address'));

// argon2 has no input limit like bcrypt's 72 bytes; the cap only bounds the
// work an attacker can make the server do per request.
export const passwordSchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128, 'must be at most 128 characters');

export const nameSchema = z.string().trim().min(1, 'is required').max(120, 'must be at most 120 characters');

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
});
export const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1, 'is required'),
  password: z.string().min(1, 'is required'),
});
export const forgotPasswordSchema = z.strictObject({ email: emailSchema });
export const resetPasswordSchema = z.strictObject({
  token: z.string().min(1, 'is required').max(200),
  newPassword: passwordSchema,
});
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1, 'is required'),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
