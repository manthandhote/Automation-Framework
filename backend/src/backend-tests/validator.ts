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

export class BackendValidator {
  private mongoUri: string;
  private dbName: string;

  constructor(mongoUri: string, sessionDbName: string) {
    this.mongoUri = mongoUri;
    this.dbName = sessionDbName;
  }

  async validateParcel(barcode: string, retries = 5, retryDelayMs = 1000): Promise<ValidationResult> {
    const startTime = Date.now();

    logger.info(`[VALIDATOR] Validating barcode: ${barcode} in DB: ${this.dbName}`, 'VALIDATOR');

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
      `[VALIDATOR] ${barcode} → L1:${layer1.found} L2:${layer2.found} L3:${layer3.found} → ${overallPass ? '✅ PASS' : '❌ FAIL'}`,
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

  // ─── Layer 1: Ingestion ────────────────────────────────────────────────────
  // Checks that the incoming-service received and stored the barcode
  private async checkLayer1(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    const collections = ['incoming_data', 'incoming_packets', 'incomingdata'];

    for (const col of collections) {
      try {
        const result = await this.findInDb(col, barcode);
        if (result) {
          return {
            layer: 'Layer1-Ingestion',
            collection: col,
            found: true,
            data: result,
            durationMs: Date.now() - start
          };
        }
      } catch (e) { }
    }

    return {
      layer: 'Layer1-Ingestion',
      collection: 'incoming_data',
      found: false,
      error: 'Not found in any incoming collection',
      durationMs: Date.now() - start
    };
  }

  // ─── Layer 2: Sorting ──────────────────────────────────────────────────────
  // Checks that validation-engine processed and stored sorting result
  private async checkLayer2(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    const collections = ['sorting_results', 'primary_sortings', 'sorting_data'];

    for (const col of collections) {
      try {
        const result = await this.findInDb(col, barcode);
        if (result) {
          return {
            layer: 'Layer2-Sorting',
            collection: col,
            found: true,
            data: result,
            durationMs: Date.now() - start
          };
        }
      } catch (e) { }
    }

    return {
      layer: 'Layer2-Sorting',
      collection: 'sorting_results',
      found: false,
      error: 'Not found in any sorting collection',
      durationMs: Date.now() - start
    };
  }

  // ─── Layer 3: Integration/Upload ──────────────────────────────────────────
  // Checks that dataposting-service logged the upload
  private async checkLayer3(barcode: string): Promise<LayerResult> {
    const start = Date.now();
    const collections = ['integration_logs', 'upload_logs', 'datapost_logs'];

    for (const col of collections) {
      try {
        const result = await this.findInDb(col, barcode);
        if (result) {
          return {
            layer: 'Layer3-Integration',
            collection: col,
            found: true,
            data: result,
            durationMs: Date.now() - start
          };
        }
      } catch (e) { }
    }

    return {
      layer: 'Layer3-Integration',
      collection: 'integration_logs',
      found: false,
      error: 'Not found in integration logs (may not have uploaded yet)',
      durationMs: Date.now() - start
    };
  }

  // ─── DB helper ────────────────────────────────────────────────────────────
  private async findInDb(collection: string, barcode: string): Promise<any | null> {
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      const db = client.db(this.dbName);

      const result = await db.collection(collection).findOne({
        $or: [
          { barcode },
          { awb: barcode },
          { barcode_data: { $elemMatch: { barcode } } },
          { 'barcode_data.barcode': barcode }
        ]
      });

      return result;
    } finally {
      await client.close();
    }
  }

  // ─── Retry wrapper ─────────────────────────────────────────────────────────
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