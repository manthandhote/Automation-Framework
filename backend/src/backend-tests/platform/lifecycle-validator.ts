import { MongoClient } from 'mongodb';

export interface ValidationStatus {
  traceId: string;
  manifested: boolean;
  scanned: boolean;
  validated: boolean;
  pushed: boolean;
  error?: string;
  lastUpdate: Date;
  details: {
    barcodeData?: any;
    sortingData?: any;
    integrationData?: any;
  };
}

export class LifecycleValidator {
  private client: MongoClient;

  constructor(private mongoUri: string, private dbName?: string) {
    this.client = new MongoClient(mongoUri);
  }

  async connect() {
    await this.client.connect();
  }

  async close() {
    await this.client.close();
  }

  /**
   * Get the full lifecycle status of a parcel by tracing it through
   * all collections in the session-scoped database.
   * 
   * If dbName was provided, all lookups happen in that single DB.
   * Otherwise, falls back to legacy multi-DB lookups.
   */
  async getParcelStatus(traceId: string): Promise<ValidationStatus> {
    const status: ValidationStatus = {
      traceId,
      manifested: false,
      scanned: false,
      validated: false,
      pushed: false,
      lastUpdate: new Date(),
      details: {},
    };

    try {
      if (this.dbName) {
        // ─── Session-scoped mode: single DB ──────────────────────────────
        const db = this.client.db(this.dbName);
        const collections = await db.listCollections().toArray();
        const colNames = collections.map(c => c.name);

        // 1. Check barcode/incoming data
        for (const name of ['incoming_data', 'incoming_packets', 'barcode_data']) {
          if (colNames.includes(name)) {
            const doc = await db.collection(name).findOne({
              $or: [{ awb: traceId }, { barcode: traceId }, { 'barcode_data.barcode': traceId }]
            });
            if (doc) {
              status.manifested = true;
              status.details.barcodeData = doc;
              break;
            }
          }
        }

        // 2. Check validation/sorting data
        for (const name of ['primary_sortings', 'sorting_results', 'validation_results']) {
          if (colNames.includes(name)) {
            const doc = await db.collection(name).findOne({
              $or: [{ awb: traceId }, { barcode: traceId }, { 'barcode_data.barcode': traceId }]
            });
            if (doc) {
              status.scanned = true;
              status.validated = true;
              status.details.sortingData = doc;
              break;
            }
          }
        }

        // 3. Check integration/upload logs
        for (const name of ['integration_logs', 'upload_logs', 'dataposting_logs']) {
          if (colNames.includes(name)) {
            const doc = await db.collection(name).findOne({
              $or: [
                { identifier: traceId },
                { barcode: traceId },
                { awb_number: traceId },
                { upload_status: 'SUCCESS', barcode: traceId }
              ]
            });
            if (doc) {
              status.pushed = true;
              status.details.integrationData = doc;
              break;
            }
          }
        }
      } else {
        // ─── Legacy mode: multi-DB lookups ─────────────────────────────
        const incomingDb = this.client.db('incoming_service');
        const manifest = await incomingDb.collection('incoming_data').findOne({
          $or: [{ awb: traceId }, { barcode: traceId }]
        });
        if (manifest) status.manifested = true;

        const primaryDb = this.client.db('validation_engine');
        const sorting = await primaryDb.collection('primary_sortings').findOne({
          $or: [{ awb: traceId }, { barcode: traceId }]
        });
        if (sorting) {
          status.scanned = true;
          status.validated = true;
        }

        const logDb = this.client.db('uploader');
        const log = await logDb.collection('integration_logs').findOne({
          identifier: traceId,
          upload_status: 'SUCCESS'
        });
        if (log) status.pushed = true;
      }
    } catch (err: any) {
      status.error = err.message;
    }

    return status;
  }
}
