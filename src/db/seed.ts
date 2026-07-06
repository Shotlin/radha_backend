/**
 * Dev-only seed entry point.
 *
 * Phase BE-05 ships a no-op seed so we have the script wiring ready.
 * Future phases append seed routines for tenants, users, products,
 * and demo data.
 */

const main = async (): Promise<void> => {
  // eslint-disable-next-line no-console
  console.info('🌱 Seeding RADHA database (BE-05 baseline — nothing to seed yet).');
  process.exit(0);
};

void main();
