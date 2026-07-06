/**
 * Drizzle schema barrel.
 *
 * Every new table file (BE-06+ users, BE-09 tenants, BE-10 products …)
 * gets re-exported here so `drizzle-kit` and the `DrizzleDb` type
 * see the full schema in one place.
 */

export * from './_base';
export * from './_enums';
export * from './audit-logs';
export * from './users';
export * from './admin-auth';
export * from './tenants';
export * from './products';
export * from './off-cache';
export * from './obf-cache';
export * from './opf-cache';
export * from './health-scoring';
export * from './media-assets';
export * from './search';
export * from './ean-lists';
export * from './scans';
export * from './expiry';
export * from './tasks';
export * from './reports';
export * from './ai';
export * from './notifications';
export * from './suppliers';
export * from './grn';
export * from './saved-products';
export * from './family-sharing-members';
export * from './allergen-profiles';
export * from './affiliate';
export * from './referrals';
export * from './recall';
export * from './ingredient-explanations';
export * from './image-fallback-cache';
export * from './idempotency-records';
export * from './webhooks';
export * from './razorpay-orders';
export * from './payment-webhooks-inbox';
export * from './impersonation';
export * from './consumer-weekly-digests';
export * from './shopping-lists';
export * from './verified-badges';
export * from './barcode-learning';
