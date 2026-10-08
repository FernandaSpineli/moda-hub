import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { conflict } from '../../common/app-error.js';
import { DB, type Db } from '../../platform/database.js';
import { isCheckViolation, isForeignKeyViolation } from '../../platform/db-errors.js';
import { catalogErrors } from '../catalog/catalog.errors.js';

export interface StockLevel {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
}

/** Stock per variant. A variant with no inventory row has none. */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext('inventory');
  }

  async level(variantId: string): Promise<StockLevel> {
    const { rows } = await this.db.execute<{
      on_hand: number;
      reserved: number;
      low_stock_threshold: number;
    }>(sql`
      SELECT COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved,
             COALESCE(i.low_stock_threshold, 3) AS low_stock_threshold
      FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
      WHERE v.id = ${variantId}`);
    const row = rows[0];
    if (!row) throw catalogErrors.variantNotFound();
    return toLevel(variantId, row);
  }

  /** Records a stock count; it can never drop below the units reserved by unpaid orders. */
  async set(variantId: string, input: { onHand: number; lowStockThreshold?: number }): Promise<StockLevel> {
    try {
      const { rows } = await this.db.execute<{
        on_hand: number;
        reserved: number;
        low_stock_threshold: number;
      }>(sql`
        INSERT INTO inventory (variant_id, on_hand, low_stock_threshold)
        VALUES (${variantId}, ${input.onHand}, ${input.lowStockThreshold ?? 3})
        ON CONFLICT (variant_id) DO UPDATE SET
          on_hand = EXCLUDED.on_hand,
          low_stock_threshold = ${input.lowStockThreshold === undefined ? sql`inventory.low_stock_threshold` : sql`EXCLUDED.low_stock_threshold`}
        RETURNING on_hand, reserved, low_stock_threshold`);
      const level = toLevel(
        variantId,
        rows[0] as { on_hand: number; reserved: number; low_stock_threshold: number },
      );
      this.logger.info(
        { variant_id: variantId, on_hand: level.onHand, reserved: level.reserved },
        'inventory.adjusted',
      );
      return level;
    } catch (err) {
      if (isForeignKeyViolation(err)) throw catalogErrors.variantNotFound();
      if (isCheckViolation(err, 'inventory_reserved_within_on_hand')) {
        throw conflict('BELOW_RESERVED', 'Stock cannot be lower than the units reserved by unpaid orders');
      }
      throw err;
    }
  }
}

function toLevel(
  variantId: string,
  r: { on_hand: number; reserved: number; low_stock_threshold: number },
): StockLevel {
  return {
    variantId,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.on_hand - r.reserved,
    lowStockThreshold: r.low_stock_threshold,
  };
}
