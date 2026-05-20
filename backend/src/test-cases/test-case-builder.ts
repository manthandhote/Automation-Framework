import { MongoClient } from 'mongodb';
import { DbSummary } from '../core/db-analyzer';
import { LlamaAnalyst, GeneratedTestCase, RealAwbContext } from './llama-analyst';
import { CodeSummary } from '../core/code-analyzer';
import { logger } from '../core/logger';

export class TestCaseBuilder {
  private llama: LlamaAnalyst;

  constructor(private mongoUri: string, private dbName: string) {
    this.llama = new LlamaAnalyst();
  }

  // ── buildWithLlm ───────────────────────────────────────────────────────────
  //
  // pushedAwbs: AWBs already seeded into incoming_data via IncomingDataSeeder.
  //
  //   If provided and non-empty:
  //     • validAwb = pushedAwbs[0]  (used for SUCC + DUPR scenarios)
  //     • The expensive DB lookup against incoming_service.incoming_data is
  //       skipped entirely — the seeder guarantees those AWBs are in the DB.
  //     • fakeAwb is still generated from the machine's barcode regex.
  //     • DNFR and IBAR scenarios are unchanged.
  //
  //   If empty (seeder was skipped or failed):
  //     • Falls back to the original DB lookup strategy.

  async buildWithLlm(
    dbSummary: DbSummary,
    codeSummary: CodeSummary,
    pushedAwbs: string[] = []    // ← NEW: injected by Orchestrator after seeding
  ): Promise<GeneratedTestCase[]> {
    const client = new MongoClient(this.mongoUri);
    const realAwbs: RealAwbContext[] = [];

    const useSeededAwbs = pushedAwbs.length > 0;
    

    if (useSeededAwbs) {
      logger.info(
        `[TEST-BUILDER] Using ${pushedAwbs.length} seeded AWBs — skipping DB lookup. validAwb: ${pushedAwbs[0]}`,
        'TEST-BUILDER'
      );
    } else {
      logger.info(
        `[TEST-BUILDER] No seeded AWBs provided — will query incoming_service.incoming_data`,
        'TEST-BUILDER'
      );
    }

    try {
      await client.connect();

      const machineDb = client.db('machine_configurations');
      // Only needed for DB-lookup fallback path
      const incomingDb = useSeededAwbs ? null : client.db('incoming_service');

      for (const machine of dbSummary.machines.filter(m => m.status)) {
        const isCsnd =
        (machine as any).isCsnd === true ||
        machine.type?.toUpperCase() === 'CSND';
        const machineKey = (machine as any).machine_key || 'MA01';

        // ── Get full machine doc (for regex + machineId) ───────────────────
        const machineDoc = await machineDb
          .collection('machines')
          .findOne({ machine_key: machineKey });

        if (!machineDoc) {
          logger.warn(
            `[TEST-BUILDER] No machine doc found for key ${machineKey}`,
            'TEST-BUILDER'
          );
          continue;
        }

        const machineId = machineDoc._id.toString();
        const barcodeRegex =
          machineDoc?.regex_config?.barcode_regex?.common_regex || '.*';

        logger.info(
          `[TEST-BUILDER] machine=${machine.name} key=${machineKey} id=${machineId} regex=${barcodeRegex}`,
          'TEST-BUILDER'
        );

        // ── Resolve validAwb ───────────────────────────────────────────────

        let validAwb: string | null = null;

        if (useSeededAwbs) {
          // ── FAST PATH: seeder already pushed these AWBs into incoming_data ──
          // Use pushedAwbs[0] as the canonical SUCC/DUPR barcode.
          // If there are multiple machines (rare), each gets the same first AWB;
          // this is intentional since all AWBs in incoming-test.json are for
          // the same client/machine config.
          validAwb = pushedAwbs[0];

          logger.info(
            `[TEST-BUILDER] ✅ validAwb from seeder: ${validAwb} for machine ${machine.name}`,
            'TEST-BUILDER'
          );

        } else {
          // ── FALLBACK PATH: query DB (original behaviour) ───────────────────
          let incomingDoc: any = null;

          // Try machine_id string match
          incomingDoc = await incomingDb!
            .collection('incoming_data')
            .findOne({ machine_id: machineId });

          logger.info(
            `[TEST-BUILDER] machine_id lookup (${machineId}): ` +
            `${incomingDoc ? 'FOUND → ' + incomingDoc.awb : 'NOT FOUND'}`,
            'TEST-BUILDER'
          );

          // Fallback: match by machine_name
          if (!incomingDoc) {
            incomingDoc = await incomingDb!
              .collection('incoming_data')
              .findOne({ machine_name: machineDoc.machine_name });

            logger.info(
              `[TEST-BUILDER] machine_name lookup (${machineDoc.machine_name}): ` +
              `${incomingDoc ? 'FOUND → ' + incomingDoc.awb : 'NOT FOUND'}`,
              'TEST-BUILDER'
            );
          }

          // Last resort: regex scan across up to 200 docs
          if (!incomingDoc) {
            const allDocs = await incomingDb!
              .collection('incoming_data')
              .find({})
              .limit(200)
              .toArray();

            const regex = new RegExp(barcodeRegex);
            incomingDoc = allDocs.find(d => d.awb && regex.test(d.awb)) || null;

            logger.info(
              `[TEST-BUILDER] regex scan fallback: ` +
              `${incomingDoc ? 'FOUND → ' + incomingDoc.awb : 'NOT FOUND'}`,
              'TEST-BUILDER'
            );
          }

          validAwb = incomingDoc?.awb || null;

          if (!validAwb) {
            logger.warn(
              `[TEST-BUILDER] ❌ No valid AWB found for machine ${machine.name} — ` +
              `NORMAL_FLOW and DUPLICATE_SCAN tests will be skipped`,
              'TEST-BUILDER'
            );
          } else {
            logger.info(
              `[TEST-BUILDER] ✅ validAwb from DB: ${validAwb} for machine ${machine.name}`,
              'TEST-BUILDER'
            );
          }
        }

        // ── Generate fake AWB (always from regex — unaffected by seeder) ──
        const fakeAwb = this.generateFakeAwb(barcodeRegex);

        realAwbs.push({
          machineId,
          machineName: machine.name,
          machineKey,
          barcodeRegex,
          validAwb,
          fakeAwb,
        });
      }

    } finally {
      await client.close();
    }

    logger.info(
      `[TEST-BUILDER] Passing ${realAwbs.length} machine context(s) to LLM`,
      'TEST-BUILDER'
    );
    const cases = await this.llama.generateTestCases(codeSummary, dbSummary, realAwbs);

    // ── Force-inject real barcodes after LLM responds ─────────────────────
    // LLM sometimes hallucinates barcodes even when given the real ones.
    // We override here in code so it's deterministic regardless of LLM output.
    for (const ctx of realAwbs) {
      if (!ctx.validAwb) continue;

      // TC-001 equivalent: normal_flow → must use a real AWB from incoming_data
      const normalCase = cases.find(c =>
        !c.isDuplicate &&
        (c.scenario === 'normal_flow' || c.expectedSortCode === 'SUCC') &&
        c.machineId === ctx.machineId
      );
      if (normalCase) {
        if (normalCase.barcode !== ctx.validAwb) {
          logger.warn(
            `[TEST-BUILDER] Overriding hallucinated barcode "${normalCase.barcode}" → "${ctx.validAwb}" for ${normalCase.testId}`,
            'TEST-BUILDER'
          );
        }
        normalCase.barcode = ctx.validAwb;
      }

      // TC-004 equivalent: duplicate_scan → must use the same real AWB as TC-001
      const duplicateCase = cases.find(c =>
        c.isDuplicate && c.machineId === ctx.machineId
      );
      if (duplicateCase) {
        duplicateCase.barcode = ctx.validAwb;
      }

      // TC-002 equivalent: dnf_rejection → must use the generated fake AWB (not from DB)
      const dnfCase = cases.find(c =>
        !c.isDuplicate &&
        (c.scenario === 'dnf_rejection' || c.expectedSortCode === 'DNFR') &&
        c.machineId === ctx.machineId
      );
      if (dnfCase && ctx.fakeAwb) {
        dnfCase.barcode = ctx.fakeAwb;
      }
    }

    return cases;
  }

  private generateFakeAwb(regexStr: string): string {
    const prefixMatch = regexStr.match(/\(\?:([A-Z|]+)\)/);
    const prefix = prefixMatch ? prefixMatch[1].split('|')[0] : 'VL';
    const unique = Date.now().toString().slice(-10);
    const candidate = `${prefix}${unique}`;
    return candidate.slice(0, 15).padEnd(12, '0');
  }
}