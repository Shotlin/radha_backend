import { z } from 'zod';

const SUBDOMAIN_RE = /^[a-z][a-z0-9-]{2,49}$/;

export const OnboardTenantSchema = z.object({
  businessName: z.string().min(2).max(200),
  subdomain: z
    .string()
    .min(3)
    .max(50)
    .regex(SUBDOMAIN_RE, 'subdomain must be lowercase alphanumeric/dash, ≥3 chars')
    .toLowerCase(),
  industry: z.string().min(2).max(100).optional(),
  ownerName: z.string().min(1).max(100),
  email: z.string().email().toLowerCase(),
  mobile: z.string().min(10).max(20),
  storeName: z.string().min(1).max(200),
  storeAddress: z.string().min(1).max(255).optional(),
  storeCity: z.string().min(1).max(100).optional(),
  storeState: z.string().min(1).max(100).optional(),
  storePincode: z.string().min(4).max(10).optional(),
  country: z.string().length(2).default('IN'),
});

export type OnboardTenantDto = z.infer<typeof OnboardTenantSchema>;

export const CreateStoreSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  type: z.string().min(1).max(50).default('retail'),
  addressLine1: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: z.string().max(10).optional(),
});
export type CreateStoreDto = z.infer<typeof CreateStoreSchema>;

export const GrantStoreAccessSchema = z.object({
  userId: z.string().uuid(),
  accessLevel: z.enum(['read', 'write', 'admin']).default('read'),
});
export type GrantStoreAccessDto = z.infer<typeof GrantStoreAccessSchema>;

export const SuspendTenantSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type SuspendTenantDto = z.infer<typeof SuspendTenantSchema>;
