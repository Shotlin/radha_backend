import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { MockS3Service } from './mock-s3.service';

/**
 * BE-13 dev-only — receiving end for `MockS3Service`'s "presigned"
 * URLs (`${baseUrl}/_mock-s3/upload|download/:key`).
 *
 * Was previously just a URL the mock service generated with no
 * controller to receive it — any real end-to-end upload attempt
 * against local dev (no AWS credentials) would 403/404 with no
 * indication why. `@Version(VERSION_NEUTRAL)` keeps this off the
 * versioned `/api/v1` surface — it isn't a real API endpoint, just
 * local plumbing so `MediaService.confirmUpload()`'s `objectExists`
 * check has something to find. Never reachable in production:
 * `MockS3Service` (and thus these URLs) is only selected when no AWS
 * credentials are configured.
 */
@Controller({ path: '_mock-s3', version: VERSION_NEUTRAL })
export class MockS3Controller {
  constructor(private readonly mockS3: MockS3Service) {}

  @Post('upload/:key')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('key') key: string,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string } | undefined,
  ): Promise<{ key: string }> {
    if (!file) {
      throw new NotFoundException('No file field in upload request');
    }
    await this.mockS3.uploadObject(
      decodeURIComponent(key),
      file.buffer,
      file.mimetype || 'application/octet-stream',
    );
    return { key };
  }

  @Get('download/:key')
  async download(@Param('key') key: string, @Res() res: Response): Promise<void> {
    try {
      const body = await this.mockS3.downloadObject(decodeURIComponent(key));
      res.status(200).send(body);
    } catch {
      res.status(404).send();
    }
  }
}
