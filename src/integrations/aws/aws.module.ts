import { Global, Module, type Provider } from '@nestjs/common';

import { ConfigService } from '@/config/config.service';

import { CloudFrontClientService } from './cloudfront/cloudfront-client.service';
import { CloudFrontService } from './cloudfront/cloudfront.service';
import { MockS3Controller } from './s3/mock-s3.controller';
import { MockS3Service } from './s3/mock-s3.service';
import { S3Service } from './s3/s3.service';

export const S3_SERVICE_TOKEN = Symbol('S3_SERVICE');

/**
 * BE-13 — AWS integration.
 *
 * `S3_SERVICE_TOKEN` is the injection point every consumer should use
 * (`@Inject(S3_SERVICE_TOKEN)`). At runtime we resolve to either the
 * real `S3Service` or `MockS3Service` based on whether AWS credentials
 * exist. This avoids accidentally calling AWS in tests / CI when no
 * real bucket is configured.
 */
const s3Provider: Provider = {
  provide: S3_SERVICE_TOKEN,
  inject: [ConfigService, S3Service, MockS3Service],
  useFactory: (config: ConfigService, real: S3Service, mock: MockS3Service) => {
    const hasCredentials =
      config.aws.accessKeyId.length > 0 && config.aws.secretAccessKey.length > 0;
    return hasCredentials ? real : mock;
  },
};

@Global()
@Module({
  controllers: [MockS3Controller],
  providers: [S3Service, MockS3Service, CloudFrontService, CloudFrontClientService, s3Provider],
  exports: [S3_SERVICE_TOKEN, CloudFrontService, CloudFrontClientService, S3Service, MockS3Service],
})
export class AwsModule {}
