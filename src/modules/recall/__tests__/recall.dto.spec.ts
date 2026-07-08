import { AcknowledgeRecallAlertParamSchema, ListRecallAlertsQuerySchema } from '../dto/recall.dto';

describe('Recall DTO schemas', () => {
  describe('ListRecallAlertsQuerySchema', () => {
    it('accepts an empty object and defaults unacknowledgedOnly to false', () => {
      const result = ListRecallAlertsQuerySchema.parse({});
      expect(result.unacknowledgedOnly).toBe(false);
      expect(result.cursor).toBeUndefined();
      expect(result.limit).toBeUndefined();
    });

    it('coerces numeric query strings into limit', () => {
      const result = ListRecallAlertsQuerySchema.parse({ limit: '25' });
      expect(result.limit).toBe(25);
    });

    it('rejects out-of-range limit', () => {
      expect(() => ListRecallAlertsQuerySchema.parse({ limit: '0' })).toThrow();
      expect(() => ListRecallAlertsQuerySchema.parse({ limit: '101' })).toThrow();
    });

    it('parses unacknowledgedOnly from string "true" / "false"', () => {
      expect(
        ListRecallAlertsQuerySchema.parse({ unacknowledgedOnly: 'true' }).unacknowledgedOnly,
      ).toBe(true);
      expect(
        ListRecallAlertsQuerySchema.parse({ unacknowledgedOnly: 'false' }).unacknowledgedOnly,
      ).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      expect(() => ListRecallAlertsQuerySchema.parse({ foo: 'bar' })).toThrow();
    });
  });

  describe('AcknowledgeRecallAlertParamSchema', () => {
    it('accepts a UUID', () => {
      const id = '11111111-1111-1111-1111-111111111111';
      expect(AcknowledgeRecallAlertParamSchema.parse({ id }).id).toBe(id);
    });

    it('rejects a non-UUID', () => {
      expect(() => AcknowledgeRecallAlertParamSchema.parse({ id: 'not-uuid' })).toThrow();
    });
  });
});
