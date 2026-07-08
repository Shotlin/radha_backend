import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { VoicePlaceholderController } from '../controllers/voice-placeholder.controller';

/**
 * BE-57 — Voice Features Deferral Marker.
 *
 * The placeholder controller has no constructor dependencies, so we
 * instantiate it directly rather than building a Nest TestingModule
 * (which would try to resolve the real `JwtAuthGuard` deps and pull
 * in the entire AuthModule). The behaviour we care about is purely:
 *
 *   1. Any voice path → throws `ServiceUnavailableException` (503).
 *   2. The error envelope carries the agreed `code` / `feature`
 *      contract that the mobile + admin surfaces consume.
 *   3. The route metadata reserves `/voice` and `@All('*')` so every
 *      method × every sub-path lands on the deferral handler.
 *   4. `JwtAuthGuard` is wired so unauthenticated probes 401 first.
 */
describe('VoicePlaceholderController (BE-57 voice deferral marker)', () => {
  let controller: VoicePlaceholderController;

  beforeEach(() => {
    controller = new VoicePlaceholderController();
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  it('throws ServiceUnavailableException (HTTP 503) on the catch-all handler', () => {
    expect(() => controller.notAvailable()).toThrow(ServiceUnavailableException);

    try {
      controller.notAvailable();
      fail('expected ServiceUnavailableException to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    }
  });

  it('error envelope includes the FEATURE_NOT_AVAILABLE code and feature flag id', () => {
    try {
      controller.notAvailable();
      fail('expected ServiceUnavailableException to be thrown');
    } catch (err) {
      const ex = err as ServiceUnavailableException;
      const body = ex.getResponse() as {
        code: string;
        message: string;
        feature: string;
      };

      // The HTTP status comes from the exception itself; the body
      // carries the agreed contract that the mobile + admin surfaces
      // pivot off (`code` + `feature`, with a human-readable message).
      expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body.code).toBe('FEATURE_NOT_AVAILABLE');
      expect(body.feature).toBe('voice_features_v2');
      expect(body.message).toMatch(/v2/i);
      expect(body.message).toMatch(/voice/i);
    }
  });

  it('throws on every invocation regardless of how many times it is called (any voice path → 503)', () => {
    // The route registration `@All('*')` means every method × every
    // sub-path lands on `notAvailable`. We can't replay HTTP methods
    // here without standing up a Nest HTTP server, but we can verify
    // the handler is the single source of truth and never returns
    // successfully — the property the route depends on.
    for (let i = 0; i < 16; i += 1) {
      expect(() => controller.notAvailable()).toThrow(ServiceUnavailableException);
    }
  });

  it('reserves the /voice namespace under controller path metadata', () => {
    const path = Reflect.getMetadata(PATH_METADATA, VoicePlaceholderController) as string;
    expect(path).toBe('voice');
  });

  it('exposes the handler as @All("*") so every HTTP method on every sub-path resolves to 503', () => {
    const proto = VoicePlaceholderController.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const handler = proto.notAvailable;
    expect(handler).toBeDefined();

    const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
    const handlerMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;

    expect(handlerPath).toBe('*');
    // Nest represents `@All` as `RequestMethod.ALL` (numeric enum).
    expect(handlerMethod).toBe(RequestMethod.ALL);
  });

  it('applies JwtAuthGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, VoicePlaceholderController) as unknown[];
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(JwtAuthGuard);
  });
});
