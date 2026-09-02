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

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const DayHoursSchema = z
  .object({
    open: z.boolean(),
    opensAt: z.string().regex(TIME_RE, 'opensAt must be HH:mm').optional(),
    closesAt: z.string().regex(TIME_RE, 'closesAt must be HH:mm').optional(),
  })
  .refine((d) => !d.open || (d.opensAt !== undefined && d.closesAt !== undefined), {
    message: 'opensAt and closesAt are required when a day is open',
  });

export const BusinessHoursSchema = z.object(
  Object.fromEntries(DAYS.map((day) => [day, DayHoursSchema])) as Record<
    (typeof DAYS)[number],
    typeof DayHoursSchema
  >,
);
export type BusinessHoursDto = z.infer<typeof BusinessHoursSchema>;

/**
 * Store Details screen (Profile > Store details). Name + full address are
 * mandatory here even though `CreateStoreSchema`'s address fields are
 * optional at store-creation time — the edit screen is where the founder
 * asked for these to be enforced. GSTIN stays optional (not every store
 * has one yet); business hours are optional so a store can be edited
 * before hours are configured.
 */
export const UpdateStoreSchema = z.object({
  name: z.string().min(1).max(200),
  addressLine1: z.string().min(1).max(255),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  pincode: z.string().min(4).max(10),
  gstin: z
    .union([z.string().regex(GSTIN_RE, 'Invalid GSTIN format'), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  businessHours: BusinessHoursSchema.optional(),
});
export type UpdateStoreDto = z.infer<typeof UpdateStoreSchema>;

export const GrantStoreAccessSchema = z.object({
  userId: z.string().uuid(),
  accessLevel: z.enum(['read', 'write', 'admin']).default('read'),
});
export type GrantStoreAccessDto = z.infer<typeof GrantStoreAccessSchema>;

export const SuspendTenantSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type SuspendTenantDto = z.infer<typeof SuspendTenantSchema>;
