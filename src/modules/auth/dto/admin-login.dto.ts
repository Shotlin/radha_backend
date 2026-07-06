import { z } from 'zod';

export const AdminLoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(255).optional(),
});
export type AdminLoginDto = z.infer<typeof AdminLoginSchema>;

export const RequestPasswordResetSchema = z.object({
  email: z.string().email().toLowerCase(),
});
export type RequestPasswordResetDto = z.infer<typeof RequestPasswordResetSchema>;

export const CompletePasswordResetSchema = z.object({
  token: z.string().min(32),
  newPassword: z.string().min(12).max(128),
});
export type CompletePasswordResetDto = z.infer<typeof CompletePasswordResetSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(12).max(128),
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must differ from current password',
    path: ['newPassword'],
  });
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;

export const VerifyEmailSchema = z.object({
  token: z.string().min(32),
});
export type VerifyEmailDto = z.infer<typeof VerifyEmailSchema>;

export const InviteAdminSchema = z.object({
  email: z.string().email().toLowerCase(),
});
export type InviteAdminDto = z.infer<typeof InviteAdminSchema>;

export const AcceptInvitationSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(1).max(100),
  password: z.string().min(12).max(128),
});
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>;
