import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { CommonModule } from './common/common.module';
import { I18nModule } from './common/i18n/i18n.module';
import { AppConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { AwsModule } from './integrations/aws/aws.module';
import { EmailModule } from './integrations/email/email.module';
import { FcmModule } from './integrations/fcm/fcm.module';
import { ObfModule } from './integrations/open-beauty-facts/obf.module';
import { OffModule } from './integrations/open-food-facts/off.module';
import { OpfModule } from './integrations/open-products-facts/opf.module';
import { RazorpayModule } from './integrations/razorpay/razorpay.module';
import { SmsModule } from './integrations/sms/sms.module';
import { UpcItemDbModule } from './integrations/upc-item-db/upc.module';
import { JobsModule } from './jobs/jobs.module';
import { LoggerModule } from './logging/logger.module';
import { AdminImpersonationModule } from './modules/admin-impersonation/admin-impersonation.module';
import { AffiliateModule } from './modules/affiliate/affiliate.module';
import { AiModule } from './modules/ai/ai.module';
import { AllergenModule } from './modules/allergen/allergen.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { BarcodeLearningModule } from './modules/barcode-learning/barcode-learning.module';
import { BusinessActivationModule } from './modules/business-activation/business-activation.module';
import { CatalogImportModule } from './modules/catalog-import/catalog-import.module';
import { EanListsModule } from './modules/ean-lists/ean-lists.module';
import { ExpiryModule } from './modules/expiry/expiry.module';
import { ExpiryCalendarModule } from './modules/expiry-calendar/expiry-calendar.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { GrnModule } from './modules/grn/grn.module';
import { HealthModule } from './modules/health/health.module';
import { HealthScoringModule } from './modules/health-scoring/health-scoring.module';
import { ImageFallbackModule } from './modules/image-fallback/image-fallback.module';
import { IngredientExplainerModule } from './modules/ingredient-explainer/ingredient-explainer.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductsModule } from './modules/products/products.module';
import { PublicProductModule } from './modules/public-product/public-product.module';
import { RateLimitingModule } from './modules/rate-limiting/rate-limiting.module';
import { RecallModule } from './modules/recall/recall.module';
import { FamilyModule } from './modules/family/family.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SavedProductsModule } from './modules/saved-products/saved-products.module';
import { ScansModule } from './modules/scans/scans.module';
import { ShoppingListModule } from './modules/shopping-list/shopping-list.module';
import { StoresModule } from './modules/stores/stores.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { SyncModule } from './modules/sync/sync.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UserLanguageModule } from './modules/user-language/user-language.module';
import { VerifiedBadgeModule } from './modules/verified-badge/verified-badge.module';
import { VoiceModule } from './modules/voice/voice.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WeeklyDigestModule } from './modules/weekly-digest/weekly-digest.module';
import { ObservabilityModule } from './observability/observability.module';

/**
 * Root application module.
 *
 *   BE-02 → AppConfigModule
 *   BE-03 → CommonModule + LoggerModule
 *   BE-04 → ObservabilityModule
 *   BE-05 → DbModule
 *   BE-06 → SmsModule + AuthModule
 *   BE-07+ register their feature modules here.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    ObservabilityModule,
    CommonModule,
    DbModule,
    // Global default: 30 req/min/IP. Individual routes tighten this
    // further via @Throttle() -- see scan/lookup/search/learn controllers.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 30 }]),
    SmsModule,
    EmailModule,
    OffModule,
    ObfModule,
    OpfModule,
    UpcItemDbModule,
    AwsModule,
    RazorpayModule,
    AuthModule,
    TenantsModule,
    StoresModule,
    ProductsModule,
    HealthScoringModule,
    MediaModule,
    EanListsModule,
    ScansModule,
    ExpiryModule,
    TasksModule,
    ReportsModule,
    AiModule,
    FcmModule,
    NotificationsModule,
    OnboardingModule,
    SuppliersModule,
    GrnModule,
    JobsModule,
    // Cron scheduler is gated on RADHA_PROCESS so @Cron() decorators
    // only fire on the scheduler process. main.api.ts / main.worker.ts /
    // main.scheduler.ts each set this env var before importing AppModule.
    // Without this gate every cron would fire 3x in production.
    ...(process.env.RADHA_PROCESS === 'scheduler' ? [ScheduleModule.forRoot()] : []),
    HealthModule,
    // BE-35..BE-57 v2 modules
    AdminImpersonationModule,
    AffiliateModule,
    AllergenModule,
    AnalyticsModule,
    BarcodeLearningModule,
    BusinessActivationModule,
    CatalogImportModule,
    ExpiryCalendarModule,
    FeatureFlagsModule,
    I18nModule,
    ImageFallbackModule,
    IngredientExplainerModule,
    InventoryModule,
    PublicProductModule,
    RateLimitingModule,
    RecallModule,
    FamilyModule,
    ReferralsModule,
    SavedProductsModule,
    ShoppingListModule,
    SubscriptionsModule,
    SyncModule,
    PaymentsModule,
    UserLanguageModule,
    VerifiedBadgeModule,
    VoiceModule,
    WebhooksModule,
    WeeklyDigestModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
