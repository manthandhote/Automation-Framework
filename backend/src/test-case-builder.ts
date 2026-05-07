import { MongoClient } from 'mongodb';
import { DbSummary } from './db-analyzer';
import { LlamaAnalyst, GeneratedTestCase, RealAwbContext } from './llama-analyst';
import { CodeSummary } from './code-analyzer';
import { logger } from './logger';

export class TestCaseBuilder {
  private llama: LlamaAnalyst;

  constructor(private mongoUri: string, private dbName: string) {
    this.llama = new LlamaAnalyst();
  }

  async buildWithLlm(dbSummary: DbSummary, codeSummary: CodeSummary): Promise<GeneratedTestCase[]> {
    const client = new MongoClient(this.mongoUri);
    const realAwbs: RealAwbContext[] = [];

    try {
      await client.connect();
      const db = client.db(this.dbName);

      for (const machine of dbSummary.machines.filter(m => m.status)) {
        const machineKey = (machine as any).machine_key || 'MA01';
        const machineId = machine.id;

        // ── Step 1: Get regex from machine doc ──
        const machineDoc = await db.collection('machines').findOne({ _id: machineId as any });
        const barcodeRegex = machineDoc?.regex_config?.barcode_regex?.common_regex || '.*';

        // ── Step 2: Find a real AWB from incoming_data ──
        // Try machine_id match first, then machine_name, then any
        let incomingDoc = await db.collection('incoming_data').findOne({ machine_id: machineId });
        
        if (!incomingDoc) {
          incomingDoc = await db.collection('incoming_data').findOne({ machine_name: machine.name });
        }

        if (!incomingDoc) {
          // Last resort: find ANY AWB that matches the machine's regex
          const allDocs = await db.collection('incoming_data').find({}).limit(100).toArray();
          const regex = new RegExp(barcodeRegex);
          incomingDoc = allDocs.find(d => d.awb && regex.test(d.awb)) || null;
        }

        const validAwb = incomingDoc?.awb || null;

        if (!validAwb) {
          logger.warn(`[TEST-BUILDER] No valid AWB found for machine ${machine.name}`, 'TEST-BUILDER');
        } else {
          logger.info(`[TEST-BUILDER] Found real AWB: ${validAwb} for machine ${machine.name}`, 'TEST-BUILDER');
        }

        // ── Step 3: Generate a fake AWB that matches regex but won't be in DB ──
        const fakeAwb = this.generateFakeAwb(barcodeRegex);

        realAwbs.push({
          machineId,
          machineName: machine.name,
          machineKey,
          barcodeRegex,
          validAwb,
          fakeAwb
        });
      }

    } finally {
      await client.close();
    }

    // ── Step 4: Pass real AWB context to LLM ──
    logger.info(`[TEST-BUILDER] Passing ${realAwbs.length} machine contexts to LLM`, 'TEST-BUILDER');
    return await this.llama.generateTestCases(codeSummary, dbSummary, realAwbs);
  }

  /**
   * Generate a barcode that matches the regex but is guaranteed not in DB.
   * Uses timestamp to ensure uniqueness.
   */
  private generateFakeAwb(regexStr: string): string {
    // Extract prefix from regex like (?:VAL|VL|VLR)
    const prefixMatch = regexStr.match(/\(\?:([A-Z|]+)\)/);
    const prefix = prefixMatch ? prefixMatch[1].split('|')[0] : 'VL';

    // Use timestamp to guarantee it won't exist in DB
    const unique = Date.now().toString().slice(-10);
    const candidate = `${prefix}${unique}`;

    // Ensure length is within 12-16 chars
    return candidate.slice(0, 15).padEnd(12, '0');
  }
}