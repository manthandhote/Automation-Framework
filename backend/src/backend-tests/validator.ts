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

// ─── Dynamic barcode query ─────────────────────────────────────────────────────
//
// Different clients store the barcode under different field names:
//   Meesho → awb
//   DHL    → hu_id
//   Others → barcode, tracking_no, shipment_no, parcel_id, consignment_id
//
// Using $or across all known field names means this works for any client
// without requiring any per-client configuration here.

const barcodeQuery = (barcode: string) => ({
  $or: [
    { awb: barcode },
    { hu_id: barcode },
    { barcode: barcode },
    { tracking_no: barcode },
    { shipment_no: barcode },
    { parcel_id: barcode },
    { consignment_id: barcode },
  ]
});

export class BackendValidator {
  private mongoUri: string;

  constructor(mongoUri: string, _sessionDbName?: string) {
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

    // overallPass is trace info only — does NOT affect test pass/fail.
    // Test pass/fail is determined by expectedSortCode vs actualSortCode in test-runner.
    const overallPass = layer1.found && layer2.found;

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
  // Key: dynamic — awb (Meesho), hu_id (DHL), barcode, tracking_no, etc.
  private async checkLayer1(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(L1_DB, L1_COLLECTION, barcodeQuery(barcode));
      return {
        layer: 'Layer1-Ingestion',
        collection: L1_COLLECTION,
        found: !!result,
        data: result ?? undefined,
        error: result ? undefined : 'Barcode not found in incoming_data',
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
  private async checkLayer2(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(L2_DB, L2_COLLECTION, barcodeQuery(barcode));
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
  // Key: nested waybill_no + all flat barcode fields
  private async checkLayer3(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    try {
      const result = await this.findInDb(
        L3_DB,
        L3_COLLECTION,
        {
          $or: [
            { 'request.body.waybill_no': barcode },
            ...barcodeQuery(barcode).$or,   // spread all flat field checks
          ]
        }
      );
      return {
        layer: 'Layer3-Integration',
        collection: L3_COLLECTION,
        found: !!result,
        data: result ?? undefined,
        error: result ? undefined : 'Barcode not found in integration_logs (may not have uploaded yet)',
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

  // ─── DB helper ────────────────────────────────────────────────────────────
  private async findInDb(dbName: string, collection: string, query: object): Promise<any | null> {
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      return await client.db(dbName).collection(collection).findOne(query);
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
    return fn();
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