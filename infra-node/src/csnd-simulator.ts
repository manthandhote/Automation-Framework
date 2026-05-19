import axios from 'axios';
import { MongoClient } from 'mongodb';
import { logger } from './logger';

export interface CsndCycleResult {
  barcode: string;
  machineKey: string;
  barcodeDispatched: boolean;
  dimensionReceived: boolean;
  weightReceived: boolean;
  bdwDispatched: boolean;
  rejectionCode: string | null;
  finalStatus: 'SORTED' | 'REJECTED' | 'ERROR' | 'INCOMPLETE';
  durationMs: number;
}

export class CsndSimulator {
  constructor(
    private appDeviceHost: string,
    private appDevicePort: number,
    private mongoUri: string,
    private machineKey: string = 'MA01'
  ) {}

  async runCycle(
    barcode: string,
    machineId: string,
    timeoutMs: number = 15000
  ): Promise<CsndCycleResult> {
    const start = Date.now();
    const result: CsndCycleResult = {
      barcode, machineKey: this.machineKey,
      barcodeDispatched: false,
      dimensionReceived: false,
      weightReceived: false,
      bdwDispatched: false,
      rejectionCode: null,
      finalStatus: 'INCOMPLETE',
      durationMs: 0,
    };

    try {
      // Step 1 — POST barcode to app-device-interface
      const url = `http://${this.appDeviceHost}:${this.appDevicePort}/app-device-interface/send-barcode`;
      logger.info(`[CSND-SIM] POST ${barcode} → ${url}`);

      const resp = await axios.post(url, { barcode, machine_id: machineId }, { timeout: 5000 });
      result.barcodeDispatched = resp.status === 200;
      logger.info(`[CSND-SIM] Barcode dispatched: HTTP ${resp.status}`);

      // Step 2 — Poll MongoDB primary_sortings for result
      const sortResult = await this.pollForResult(barcode, timeoutMs);
      if (sortResult) {
        result.rejectionCode = sortResult.display_rejection || null;
        result.bdwDispatched = true;
        result.dimensionReceived = !!(sortResult.length || sortResult.dimension);
        result.weightReceived = !!(sortResult.weight);
        result.finalStatus = (!sortResult.display_rejection || sortResult.display_rejection === 'SUCC')
          ? 'SORTED' : 'REJECTED';
      }

    } catch (err: any) {
      logger.error(`[CSND-SIM] Cycle error: ${err.message}`);
      result.finalStatus = 'ERROR';
    }

    result.durationMs = Date.now() - start;
    return result;
  }

  private async pollForResult(barcode: string, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      const db = client.db('sorting_service');
      while (Date.now() < deadline) {
        const doc = await db.collection('primary_sortings')
          .findOne({ barcode }, { sort: { created_at: -1 } });
        if (doc) {
          logger.info(`[CSND-SIM] Result for ${barcode}: ${doc.display_rejection ?? 'SUCC'}`);
          return doc;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      logger.warn(`[CSND-SIM] Timeout polling for ${barcode}`);
      return null;
    } finally {
      await client.close();
    }
  }
}