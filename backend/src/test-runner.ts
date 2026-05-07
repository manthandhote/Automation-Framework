import path from 'path';
import fs from 'fs';
import { simulateOnInfra } from './index';
import { BackendValidator, ValidationResult } from './validator';
import { UIValidator } from './ui-validator';
import { InspectraDB } from './inspectra-db';
import { logger } from './logger';
import { DbSummary } from './db-analyzer';

export interface SimulationResult {
  trackingId: string;
  protocol: string;
  pbResponse: string;
  pdResponse: string;
  pcResponse: string;
  lastResponse: string;
}

export interface TestCase {
  testId: string;
  service: string;
  scenario: string;
  description: string;
  expectedStatus: 'PASS' | 'FAIL';
  barcode?: string;
  machineName?: string;
  configName?: string;
  endpoint?: string;
  method?: string;
  payload?: any;
  isDuplicate?: boolean;
  protocol?: any;
  expectedSortCode?: string;
  weight?: number;
  dims?: { l: number, b: number, h: number };
}

export interface TestResult {
  testId: string;
  scenario: string;
  barcode: string;
  machineName: string;
  expectedStatus: 'PASS' | 'FAIL';
  actualStatus: 'PASS' | 'FAIL' | 'ERROR';
  passed: boolean;

  // Phase results
  simulation: SimulationResult | null;
  validation: ValidationResult | null;
  uiResult: any | null;

  // Meta
  durationMs: number;
  error?: string;
  reason?: string;
  screenshotPath?: string;
}

export class TestRunner {
  private uiValidator: UIValidator;
  private inspectraDb: InspectraDB;

  constructor(
    private mongoUri: string,
    private workspacePath: string
  ) {
    this.uiValidator = new UIValidator();
    this.inspectraDb = InspectraDB.getInstance();
  }

  // ─── Run all test cases for a session ─────────────────────────────────────
  async runAll(
    sessionId: string,
    testCases: TestCase[],
    dbSummary: DbSummary,
    onLog?: (msg: string) => void
  ): Promise<TestResult[]> {
    const sessionDbName = `inspectra_csnd_${sessionId}`;
    const runsDir = path.join(this.workspacePath, 'runs', `run_${sessionId}`);
    const screenshotsDir = path.join(runsDir, 'screenshots');

    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    onLog?.(`[TEST-RUNNER] Starting ${testCases.length} test cases for session ${sessionId}`);

    const results: TestResult[] = [];

    for (const tc of testCases) {
      onLog?.(`[TEST-RUNNER] ▶ Running ${tc.testId}: ${tc.description}`);

      const result = await this.runSingle(
        tc,
        sessionId,
        sessionDbName,
        dbSummary,
        screenshotsDir,
        onLog
      );

      results.push(result);

      // Save result to DB
      await this.inspectraDb.saveResult({
        sessionId,
        testId: tc.testId,
        barcode: result.barcode,
        service: tc.service,
        status: result.actualStatus,
        reason: result.reason || result.error || (result.passed ? 'Passed' : 'Failed'),
        trace: result.validation ? {
          ingestion: result.validation.layer1_ingestion.found,
          sorting: result.validation.layer2_sorting.found,
          integration: result.validation.layer3_integration.found
        } : null,
        executedAt: new Date()
      });

      onLog?.(
        `[TEST-RUNNER] ${result.passed ? '✅' : '❌'} ${tc.testId} → ${result.actualStatus} (${result.durationMs}ms)`
      );

      // Small gap between test cases
      await this.sleep(500);
    }

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    onLog?.(`[TEST-RUNNER] ✅ Complete: ${passed} passed, ${failed} failed out of ${results.length}`);

    return results;
  }

  // ─── Run a single test case through all 3 phases ──────────────────────────
  private async runSingle(
    tc: TestCase,
    sessionId: string,
    sessionDbName: string,
    dbSummary: DbSummary,
    screenshotsDir: string,
    onLog?: (msg: string) => void
  ): Promise<TestResult> {
    const startTime = Date.now();
    const barcode = tc.barcode || this.generateBarcode();
    const machineId = (tc as any).machineId;
    
    const machineName = tc.machineName || dbSummary.machines[0]?.name || 'Unknown';

    // Find machine config for TCP port
    const machine = dbSummary.machines.find(m =>
      m.id === machineId ||
      (m as any).machine_key === machineName
    ) || dbSummary.machines[0];
    const tcpPort = 3000; // app-device-interface TCP server port from machine config

    let simulation: SimulationResult | null = null;
    let validation: ValidationResult | null = null;
    let uiResult: any | null = null;
    let screenshotPath: string | undefined;

    try {
      // ── PHASE 1: Hardware Simulation ───────────────────────────────────────
      onLog?.(`  [PHASE 1] Injecting ${barcode} into TCP port ${tcpPort}...`);

      const protocol = machine?.type?.includes('astro') ? 'astro' : 'capella';

      const machineKey = (tc as any).machineName  
        || (machine as any)?.machine_key        
        || 'MA01'; 
      if (tc.isDuplicate) {
        // For duplicate test: run cycle twice, second run should return SBRR
        await simulateOnInfra({ barcode: tc.barcode, machineKey, protocol: tc.protocol || 'capella', transport: 'tcp', options: { host: '127.0.0.1', port: 3000 } });
        await new Promise(r => setTimeout(r, 1000));

        const secondResult = await simulateOnInfra({ barcode: tc.barcode, machineKey, protocol: tc.protocol || 'capella', transport: 'tcp', options: { host: '127.0.0.1', port: 3000 } });

        const allSecondResponses = [
          secondResult.pbResponse,
          secondResult.pdResponse,
          secondResult.pcResponse
        ].filter(Boolean).join(' ');

        const gotSbrr = allSecondResponses.includes('SBRR');

        return {
          testId: tc.testId,
          scenario: tc.scenario,
          barcode,
          machineName,
          expectedStatus: tc.expectedStatus,
          actualStatus: gotSbrr ? 'PASS' : 'FAIL',
          passed: gotSbrr,
          simulation: secondResult,
          validation: null,
          uiResult: null,
          durationMs: Date.now() - startTime
        };
      }
      const dims = (tc as any).dims || { l: 187, b: 172, h: 47 };
      const weight = (tc as any).weight || 0.12;
      simulation = await simulateOnInfra({ barcode, machineKey, protocol, dims, weight, transport: 'tcp', options: { host: '127.0.0.1', port: tcpPort } });
      if (tc.expectedSortCode) {
        // DNFR/IBAR/CFGR/SBRR are in pbResponse (barcode validation response)
        // SUCC is also in pbResponse for successful sorts
        const allResponses = [
          simulation?.pbResponse,
          simulation?.pdResponse,
          simulation?.pcResponse
        ].filter(Boolean).join(' ');

        onLog?.(`  [PHASE 1] Responses — PB:${simulation?.pbResponse} PD:${simulation?.pdResponse} PC:${simulation?.pcResponse}`);

        const passed = allResponses.includes(tc.expectedSortCode);

        return {
          testId: tc.testId,
          scenario: tc.scenario,
          barcode,
          machineName,
          expectedStatus: tc.expectedStatus,
          actualStatus: passed ? 'PASS' : 'FAIL',
          passed,
          simulation,
          validation: null,
          uiResult: null,
          durationMs: Date.now() - startTime,
          reason: passed
            ? `Got expected ${tc.expectedSortCode}`
            : `Expected ${tc.expectedSortCode}, got: ${allResponses}`
        };
      }
      onLog?.(`  [PHASE 1] ✅ Simulation done — tracking: ${(simulation as any).trackingId}`);

      // Wait for services to process
      await this.sleep(6000);

      // ── PHASE 2: Backend Validation ────────────────────────────────────────
      onLog?.(`  [PHASE 2] Validating barcode in DB layers...`);

      const validator = new BackendValidator(this.mongoUri, sessionDbName);
      validation = await validator.validateParcel(barcode, 10, 2000);

      onLog?.(`  [PHASE 2] L1:${validation.layer1_ingestion.found} L2:${validation.layer2_sorting.found} L3:${validation.layer3_integration.found}`);

      // ── PHASE 3: Frontend Validation ──────────────────────────────────────
      onLog?.(`  [PHASE 3] Validating UI display using DOM assertions...`);

      try {
        const commitId = (tc as any).commitId || 'latest';
        const apiResponse = { status: validation?.overallPass ? 'PASS' : 'FAIL' };
        uiResult = await this.uiValidator.validateParcelDisplay(
            'http://localhost:7001/FE-CSND/CL0003/master_search.php', barcode, sessionId, commitId, apiResponse
        );
        onLog?.(`  [PHASE 3] UI: ${uiResult?.status} | ${uiResult?.reason}`);
      } catch (uiErr: any) {
        onLog?.(`  [PHASE 3] ⚠️ UI check skipped: ${uiErr.message}`);
        uiResult = { found: false, error: uiErr.message, status: 'ERROR' };
      }

      // ── Determine Pass/Fail ────────────────────────────────────────────────
      const backendPassed = validation.overallPass;
      const actualStatus: 'PASS' | 'FAIL' = backendPassed ? 'PASS' : 'FAIL';
      const passed = actualStatus === tc.expectedStatus;

      return {
        testId: tc.testId,
        scenario: tc.scenario,
        barcode,
        machineName,
        expectedStatus: tc.expectedStatus,
        actualStatus,
        passed,
        simulation,
        validation,
        uiResult,
        durationMs: Date.now() - startTime,
        screenshotPath
      };

    } catch (err: any) {
      logger.error(`[TEST-RUNNER] ${tc.testId} crashed: ${err.message}`, 'TEST-RUNNER');
      return {
        testId: tc.testId,
        scenario: tc.scenario,
        barcode,
        machineName,
        expectedStatus: tc.expectedStatus,
        actualStatus: 'ERROR',
        passed: false,
        simulation,
        validation,
        uiResult,
        durationMs: Date.now() - startTime,
        error: err.message
      };
    }
  }

  private generateBarcode(): string {
    const prefixes = ['VL', 'VAL'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const num = Math.floor(Math.random() * 9999999999999).toString().padStart(13, '0');
    return `${prefix}${num}`.slice(0, 16);
  }

  async assembleFinalReport(
    sessionId: string,
    vmId: string,
    gitData: any,
    infraData: any,
    performanceData: any,
    comparisonData: any,
    alertsData: any[],
    rootCauses: string[],
    testResults: TestResult[]
  ) {
    const total = testResults.length;
    const pass = testResults.filter(r => r.actualStatus === 'PASS' || r.uiResult?.status === 'PASS').length;
    const healed = testResults.filter(r => r.uiResult?.status === 'HEALED').length;
    const fail = total - pass - healed;

    const report = {
      test_run_id: sessionId,
      vm_id: vmId,
      git: gitData,
      infra: infraData,
      execution: {
        steps: testResults.map(r => ({
          step_id: r.testId,
          action: r.scenario || 'validation',
          expected: r.expectedStatus,
          actual: r.uiResult?.status || r.actualStatus,
          status: r.uiResult?.status || r.actualStatus,
          reason: r.uiResult?.reason || r.error || 'Passed'
        })),
        summary: { total, pass, fail, healed }
      },
      performance: performanceData,
      comparison: comparisonData,
      alerts: alertsData,
      root_causes: rootCauses
    };

    return report;
  }

  private sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}