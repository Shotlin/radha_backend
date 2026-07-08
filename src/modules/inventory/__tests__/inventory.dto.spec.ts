import { AdjustStockSchema } from '../dto/adjust-stock.dto';
import {
  InventorySummaryQuerySchema,
  ListInventoryQuerySchema,
  ListMovementsQuerySchema,
} from '../dto/list-inventory.dto';
import { LowStockRuleSchema } from '../dto/low-stock-rule.dto';
import {
  CancelStockCountSchema,
  RecordCountLineSchema,
  StartStockCountSchema,
} from '../dto/stock-count.dto';
import { StockInSchema } from '../dto/stock-in.dto';
import { StockOutSchema } from '../dto/stock-out.dto';

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('StockInSchema', () => {
  it('accepts a minimal payload', () => {
    const result = StockInSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe('manual_in');
  });

  it('rejects negative quantity', () => {
    const result = StockInSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer quantity', () => {
    const result = StockInSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when expiryDate <= manufactureDate', () => {
    const result = StockInSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 1,
      expiryDate: '2026-01-01',
      manufactureDate: '2026-06-01',
    });
    expect(result.success).toBe(false);
  });

  it('caps quantity at 1_000_000', () => {
    const result = StockInSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 1_000_001,
    });
    expect(result.success).toBe(false);
  });
});

describe('StockOutSchema', () => {
  it('defaults reason to "sale"', () => {
    const result = StockOutSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe('sale');
  });

  it('rejects zero quantity', () => {
    const result = StockOutSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      quantity: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('AdjustStockSchema', () => {
  it('accepts newQuantity = 0 (clearing stock is legitimate)', () => {
    const result = AdjustStockSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      newQuantity: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative newQuantity', () => {
    const result = AdjustStockSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      newQuantity: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('LowStockRuleSchema', () => {
  it('accepts a product-scoped rule', () => {
    const result = LowStockRuleSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      threshold: 5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a category-scoped rule', () => {
    const result = LowStockRuleSchema.safeParse({
      category: 'beverages',
      storeId: VALID_UUID,
      threshold: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects when both productId and category are set', () => {
    const result = LowStockRuleSchema.safeParse({
      productId: VALID_UUID,
      category: 'beverages',
      storeId: VALID_UUID,
      threshold: 5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects when neither productId nor category is set', () => {
    const result = LowStockRuleSchema.safeParse({
      storeId: VALID_UUID,
      threshold: 5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative threshold', () => {
    const result = LowStockRuleSchema.safeParse({
      productId: VALID_UUID,
      storeId: VALID_UUID,
      threshold: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('Stock count DTOs', () => {
  it('StartStockCountSchema accepts minimal body', () => {
    const result = StartStockCountSchema.safeParse({ storeId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  it('RecordCountLineSchema requires productId + countedQuantity', () => {
    const result = RecordCountLineSchema.safeParse({
      productId: VALID_UUID,
      countedQuantity: 0,
    });
    expect(result.success).toBe(true);
  });

  it('RecordCountLineSchema rejects negative countedQuantity', () => {
    const result = RecordCountLineSchema.safeParse({
      productId: VALID_UUID,
      countedQuantity: -1,
    });
    expect(result.success).toBe(false);
  });

  it('CancelStockCountSchema requires non-empty reason', () => {
    expect(CancelStockCountSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(CancelStockCountSchema.safeParse({ reason: 'closed' }).success).toBe(true);
  });
});

describe('List query DTOs', () => {
  it('ListInventoryQuerySchema parses isLowStock=true from string', () => {
    const result = ListInventoryQuerySchema.safeParse({ isLowStock: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isLowStock).toBe(true);
  });

  it('ListInventoryQuerySchema parses isLowStock=false from string', () => {
    const result = ListInventoryQuerySchema.safeParse({ isLowStock: 'false' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isLowStock).toBe(false);
  });

  it('ListInventoryQuerySchema defaults limit to 50, caps at 200', () => {
    const ok = ListInventoryQuerySchema.safeParse({});
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.limit).toBe(50);

    const cap = ListInventoryQuerySchema.safeParse({ limit: 999 });
    expect(cap.success).toBe(false);
  });

  it('ListMovementsQuerySchema accepts type and reason filters', () => {
    const result = ListMovementsQuerySchema.safeParse({
      type: 'in',
      reason: 'grn_post',
      storeId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('InventorySummaryQuerySchema requires storeId', () => {
    expect(InventorySummaryQuerySchema.safeParse({}).success).toBe(false);
    expect(InventorySummaryQuerySchema.safeParse({ storeId: VALID_UUID }).success).toBe(true);
  });
});
