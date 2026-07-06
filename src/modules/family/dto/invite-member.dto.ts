import { z } from 'zod';

export const InviteMemberSchema = z.object({
  mobile: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/, 'Provide a valid Indian mobile number (+91XXXXXXXXXX)'),
});

export type InviteMemberDto = z.infer<typeof InviteMemberSchema>;
