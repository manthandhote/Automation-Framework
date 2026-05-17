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

// ── All known barcode field names across clients ──────────────────────────────
// Meesho: awb
// DHL:    hu_id
// Generic: barcode, barcode_data.barcode
const BARCODE_QUERY = (traceId: string) => ({
  $or: [
    { awb: traceId },
    { hu_id: traceId },
    { barcode: traceId },
    { 'barcode_data.barcode': traceId },
    { tracking_no: traceId },
    { shipment_no: traceId },
  ]
});

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
   * NOTE: This is TRACE DATA ONLY — it does not affect test pass/fail.
   * Pass/fail is determined solely by comparing the TCP sort code response
   * against tc.expectedSortCode in the test runner.
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
            const doc = await db.collection(name).findOne(BARCODE_QUERY(traceId));
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
            const doc = await db.collection(name).findOne(BARCODE_QUERY(traceId));
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
                { awb: traceId },
                { hu_id: traceId },
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
        const manifest = await incomingDb
          .collection('incoming_data')
          .findOne(BARCODE_QUERY(traceId));
        if (manifest) status.manifested = true;

        const primaryDb = this.client.db('sorting_service');
        const sorting = await primaryDb
          .collection('primary_sortings')
          .findOne(BARCODE_QUERY(traceId));
        if (sorting) {
          status.scanned = true;
          status.validated = true;
          status.details.sortingData = sorting;
        }

        const logDb = this.client.db('data_uploader_service');
        const log = await logDb.collection('integration_logs').findOne({
          $or: [
            { identifier: traceId },
            { awb: traceId },
            { hu_id: traceId },
            { barcode: traceId },
          ]
        });
        if (log) {
          status.pushed = true;
          status.details.integrationData = log;
        }
      }
    } catch (err: any) {
      status.error = err.message;
    }

    return status;
  }
}