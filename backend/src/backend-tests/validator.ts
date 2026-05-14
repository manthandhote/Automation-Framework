import { MongoClient } from 'mongodb';
import { logger } from '../core/logger';

export interface ValidationResult {
  barcode: string;
  layer1_ingestion: LayerResult;
  layer2_sorting: LayerResult;
  layer3_integration: LayerResult;
  overallPass: boolean;
  durationMs: number;
}

export interface LayerResult {
  layer: string;
  collection: string;
  found: boolean;
  data?: any;
  error?: string;
  durationMs: number;
}

// ─── DB / Collection constants ────────────────────────────────────────────────
const L1_DB = 'incoming_service';
const L1_COLLECTION = 'incoming_data';

const L2_DB = 'sorting_service';
const L2_COLLECTION = 'primary_sortings';

const L3_DB = 'data_uploader_service';
const L3_COLLECTION = 'integration_logs';

export class BackendValidator {
  private mongoUri: string;

  constructor(mongoUri: string, _sessionDbName?: string) {
    // _sessionDbName kept for API compatibility but is no longer used for queries.
    // Each layer now targets its own dedicated database.
    this.mongoUri = mongoUri;
  }

  async validateParcel(barcode: string, retries = 5, retryDelayMs = 1000): Promise<ValidationResult> {
    const startTime = Date.now();

    logger.info(
      `[VALIDATOR] Validating barcode: ${barcode} across [${L1_DB}, ${L2_DB}, ${L3_DB}]`,
      'VALIDATOR'
    );

    const layer1 = await this.retryCheck(
      () => this.checkLayer1(barcode),
      retries, retryDelayMs, 'Layer1-Ingestion'
    );

    const layer2 = await this.retryCheck(
      () => this.checkLayer2(barcode),
      retries, retryDelayMs, 'Layer2-Sorting'
    );

    const layer3 = await this.retryCheck(
      () => this.checkLayer3(barcode),
      retries, retryDelayMs, 'Layer3-Integration'
    );

    const overallPass = layer1.found && layer2.found;
    // Layer 3 is best-effort — not all flows upload

    logger.info(
      `[VALIDATOR] ${barcode} → found in incoming_data:${layer1.found ? '✅' : '❌'} | found in primary_sortings:${layer2.found ? '✅' : '❌'} | found in integration_logs:${layer3.found ? '✅' : '❌'} → ${overallPass ? '✅ PASS' : '❌ FAIL'}`,
      'VALIDATOR'
    );

    return {
      barcode,
      layer1_ingestion: layer1,
      layer2_sorting: layer2,
      layer3_integration: layer3,
      overallPass,
      durationMs: Date.now() - startTime
    };
  }

  // ─── Layer 1: Ingestion ───────────────────────────────────────────────────
  // DB:  incoming_service
  // Col: incoming_data
  // Key: awb  (no top-level barcode field in this collection)
  private async checkLayer1(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(
        L1_DB,
        L1_COLLECTION,
        { awb: barcode }
      );
      return {
        layer: 'Layer1-Ingestion',
        collection: L1_COLLECTION,
        found: !!result,
        data: result ?? undefined,
        error: result ? undefined : 'AWB not found in incoming_data',
        durationMs: Date.now() - start
      };
    } catch (e: any) {
      return {
        layer: 'Layer1-Ingestion',
        collection: L1_COLLECTION,
        found: false,
        error: e.message,
        durationMs: Date.now() - start
      };
    }
  }

  // ─── Layer 2: Sorting ─────────────────────────────────────────────────────
  // DB:  sorting_service
  // Col: primary_sortings
  // Key: barcode (primary) | awb (fallback — same value, belt-and-suspenders)
  private async checkLayer2(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(
        L2_DB,
        L2_COLLECTION,
        { $or: [{ barcode }, { awb: barcode }] }
      );
      return {
        layer: 'Layer2-Sorting',
        collection: L2_COLLECTION,
        found: !!result,
        data: result ?? undefined,
        error: result ? undefined : 'Barcode not found in primary_sortings',
        durationMs: Date.now() - start
      };
    } catch (e: any) {
      return {
        layer: 'Layer2-Sorting',
        collection: L2_COLLECTION,
        found: false,
        error: e.message,
        durationMs: Date.now() - start
      };
    }
  }

  // ─── Layer 3: Integration / Upload ────────────────────────────────────────
  // DB:  data_uploader_service
  // Col: integration_logs
  // Key: request.body.waybill_no  (barcode is nested — NOT a top-level field)
  private async checkLayer3(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(
        L3_DB,
        L3_COLLECTION,
        { 'request.body.waybill_no': barcode }
      );
      return {
        layer: 'Layer3-Integration',
        collection: L3_COLLECTION,
        found: !!result,
        data: result ?? undefined,
        error: result ? undefined : 'Waybill not found in integration_logs (may not have uploaded yet)',
        durationMs: Date.now() - start
      };
    } catch (e: any) {
      return {
        layer: 'Layer3-Integration',
        collection: L3_COLLECTION,
        found: false,
        error: e.message,
        durationMs: Date.now() - start
      };
    }
  }

  // ─── DB helper ───────────────────────────────────────────────────────────
  // Now accepts explicit dbName + collection + query per call.
  // No more shared this.dbName across all layers.
  private async findInDb(dbName: string, collection: string, query: object): Promise<any | null> {
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      const result = await client.db(dbName).collection(collection).findOne(query);
      return result;
    } finally {
      await client.close();
    }
  }

  // ─── Retry wrapper ────────────────────────────────────────────────────────
  private async retryCheck(
    fn: () => Promise<LayerResult>,
    retries: number,
    delayMs: number,
    label: string
  ): Promise<LayerResult> {
    for (let i = 0; i < retries; i++) {
      const result = await fn();
      if (result.found) return result;
      if (i < retries - 1) {
        logger.debug(`[VALIDATOR] ${label} not found yet, retry ${i + 1}/${retries}...`, 'VALIDATOR');
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return fn(); // final attempt
  }

  // ─── Get full parcel status (used by /api/validate endpoint) ─────────────
  async getParcelStatus(barcode: string): Promise<any> {
    const result = await this.validateParcel(barcode, 1, 0);
    return {
      barcode,
      found: result.overallPass,
      layers: {
        ingestion: result.layer1_ingestion,
        sorting: result.layer2_sorting,
        integration: result.layer3_integration
      }
    };
  }
}