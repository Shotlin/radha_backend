import type { NextFunction, Request, Response } from 'express';

import { AcceptLanguageMiddleware } from '../middleware/accept-language.middleware';
import type { SupportedLocale } from '../types/locale.types';

type LocalisedRequest = Request & { locale?: SupportedLocale };

describe('AcceptLanguageMiddleware', () => {
  const middleware = new AcceptLanguageMiddleware();

  const buildReq = (header?: string | string[] | undefined): LocalisedRequest =>
    ({
      headers: header === undefined ? {} : { 'accept-language': header },
    }) as unknown as LocalisedRequest;

  const runMiddleware = (header?: string | string[] | undefined): LocalisedRequest => {
    const req = buildReq(header);
    const res = {} as Response;
    const next = jest.fn() as unknown as NextFunction;
    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req;
  };

  describe('use() — sets req.locale', () => {
    it("defaults to 'en' when no Accept-Language header is present", () => {
      expect(runMiddleware(undefined).locale).toBe('en');
    });

    it("falls back to 'en' on an empty header", () => {
      expect(runMiddleware('').locale).toBe('en');
    });

    it('parses a single supported language', () => {
      expect(runMiddleware('hi').locale).toBe('hi');
    });

    it('strips the region subtag (en-US → en)', () => {
      expect(runMiddleware('en-US').locale).toBe('en');
    });

    it('strips the region subtag (hi-IN → hi)', () => {
      expect(runMiddleware('hi-IN').locale).toBe('hi');
    });

    it('picks the first supported language in the list', () => {
      // Klingon and ELvish are unsupported; mr is.
      expect(runMiddleware('tlh, qya, mr').locale).toBe('mr');
    });

    it('honours q-weights when picking among supported languages', () => {
      // ta has higher q than hi, so ta wins despite hi appearing first.
      expect(runMiddleware('hi;q=0.5, ta;q=0.9').locale).toBe('ta');
    });

    it("falls back to 'en' when no entry is supported", () => {
      expect(runMiddleware('fr-CA, de, ja').locale).toBe('en');
    });

    it("treats wildcard '*' as default", () => {
      expect(runMiddleware('*').locale).toBe('en');
    });

    it('handles array headers (Express occasionally yields one)', () => {
      expect(runMiddleware(['te', 'en']).locale).toBe('te');
    });

    it('skips entries it cannot parse and continues searching', () => {
      expect(runMiddleware('not-a-language;q=invalid, bn').locale).toBe('bn');
    });
  });

  describe('resolve() — direct API', () => {
    it('returns en for null/undefined input', () => {
      expect(AcceptLanguageMiddleware.resolve(undefined)).toBe('en');
      expect(AcceptLanguageMiddleware.resolve(null)).toBe('en');
    });

    it('returns the chosen locale', () => {
      expect(AcceptLanguageMiddleware.resolve('te')).toBe('te');
    });
  });
});
