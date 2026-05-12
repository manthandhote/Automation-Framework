import path from 'path';
import fs from 'fs';
import * as net from 'net';
import { simulateOnInfra } from '../index';
import { BackendValidator, ValidationResult } from './validator';
import { UIValidator } from '../frontend-tests/ui-validator';
import { InspectraDB } from '../core/inspectra-db';
import { logger } from '../core/logger';
import { DbSummary } from '../core/db-analyzer';

export interface SimulationResult {
  trackingId: string;
  barcode: string;
  machineKey: string;
  steps: Array<{
    type: 'PB' | 'PD' | 'PC';
    packet: string;
    response: string;
    accepted: boolean;
  }>;
  finalStatus: 'SORTED' | 'REJECTED_PB' | 'REJECTED_PD' | 'ERROR' | 'INCOMPLETE';
  sortLocation?: string;
  rejectionCode?: string;
  durationMs: number;
}

function extractResponses(sim: SimulationResult): {
  pbResponse: string;
  pdResponse: string;
  pcResponse: string;
} {
  const pb = sim.steps.find(s => s.type === 'PB');
  const pd = sim.steps.find(s => s.type === 'PD');
  const pc = sim.steps.find(s => s.type === 'PC');

  return {
    pbResponse: pb?.response ?? '',
    pdResponse: pd?.response ?? '',
    pcResponse: pc?.response ?? '',
  };
}

export interface TestCase {
  testId: string;
  service: string;
  scenario: string;
  description: string;
  expectedStatus: 'PASS' | 'FAIL';
  barcode?: string;
  machineName?: string;
  machineId?: string;
  configName?: string;
  endpoint?: string;
  method?: string;
  payload?: any;
  isDuplicate?: boolean;
  protocol?: any;
  expectedSortCode?: string;
  weight?: number;
  dims?: { l: number; b: number; h: number };
}

export interface TestResult {
  testId: string;
  scenario: string;
  barcode: string;
  machineName: string;
  expectedStatus: 'PASS' | 'FAIL';
  actualStatus: 'PASS' | 'FAIL' | 'ERROR';
  passed: boolean;

  simulation: SimulationResult | null;
  validation: ValidationResult | null;
  uiResult: any | null;

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

  // ─────────────────────────────────────────────────────────────
  // Resolve VM Host
  // ─────────────────────────────────────────────────────────────
  private resolveVmHost(): string {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || '';
    const match = orchestratorUrl.match(/https?:\/\/([\d.]+)/);

    if (match?.[1]) {
      return match[1];
    }

    return process.env.VM_HOST || '127.0.0.1';
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for TCP Port
  // ─────────────────────────────────────────────────────────────
  private async waitForPort(
    host: string,
    port: number,
    timeoutMs: number = 60000,
    intervalMs: number = 1000,
    label: string = `${host}:${port}`,
    onLog?: (msg: string) => void
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;

      const ready = await new Promise<boolean>((resolve) => {
        const sock = new net.Socket();

        const timer = setTimeout(() => {
          sock.destroy();
          resolve(false);
        }, 1000);

        sock.connect(port, host, () => {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        });

        sock.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      if (ready) {
        onLog?.(`  [READY] ${label} is up (attempt ${attempt})`);
        return;
      }

      if (attempt % 5 === 0) {
        onLog?.(
          `  [WAIT] ${label} not ready yet... (${Math.round(
            (deadline - Date.now()) / 1000
          )}s left)`
        );
      }

      await this.sleep(intervalMs);
    }

    throw new Error(`Timeout waiting for ${label}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Wait For All Services
  // ─────────────────────────────────────────────────────────────
  private async waitForAllServices(onLog?: (msg: string) => void): Promise<void> {
    onLog?.('  [STARTUP] Waiting for all services to be ready...');
    const vmHost = this.resolveVmHost();

    // Wait for app-device-interface HTTP port (5500), not TCP device port (3000)
    await this.waitForPort(vmHost, 5500, 60000, 1000,
      `app-device-interface ${vmHost}:5500`, onLog);

    // Wait for validation-engine
    await this.waitForPort(vmHost, 5000, 60000, 1000,
      `validation-engine ${vmHost}:5000`, onLog);

    onLog?.('  [STARTUP] Ports open — waiting 3s...');
    await this.sleep(3000);
    onLog?.('  [STARTUP] ✅ All services ready.');
  }

  // ─────────────────────────────────────────────────────────────
  // Run All Tests
  // ─────────────────────────────────────────────────────────────
  async runAll(
    sessionId: string,
    testCases: TestCase[],
    dbSummary: DbSummary,
    onLog?: (msg: string) => void
  ): Promise<TestResult[]> {

    const sessionDbName = `inspectra_csnd_${sessionId}`;

    const runsDir = path.join(
      this.workspacePath,
      'runs',
      `run_${sessionId}`
    );

    const screenshotsDir = path.join(runsDir, 'screenshots');

    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    onLog?.(
      `[TEST-RUNNER] Starting ${testCases.length} test cases`
    );

    await this.waitForAllServices(onLog);

    const results: TestResult[] = [];

    for (const tc of testCases) {

      onLog?.(
        `[TEST-RUNNER] ▶ Running ${tc.testId}: ${tc.description}`
      );

      const result = await this.runSingle(
        tc,
        sessionId,
        sessionDbName,
        dbSummary,
        screenshotsDir,
        onLog
      );

      results.push(result);

      await this.inspectraDb.saveResult({
        sessionId,
        testId: tc.testId,
        barcode: result.barcode,
        service: tc.service,
        scenario: tc.scenario,
        expectedStatus: tc.expectedStatus,
        status: result.actualStatus,
        passed: result.passed,
        rejectionCode: result.uiResult?.displayedRejectionCode || result.simulation?.rejectionCode || undefined,
        reason: result.reason ||
          result.error ||
          (result.passed
            ? `Expected ${tc.expectedStatus} → Got ${result.actualStatus} ✅`
            : `Expected ${tc.expectedStatus} → Got ${result.actualStatus} ❌`),
        trace: result.validation
          ? {
            ingestion: result.validation.layer1_ingestion.found,
            sorting: result.validation.layer2_sorting.found,
            integration: result.validation.layer3_integration.found,
          }
          : null,
        uiFound: result.uiResult?.found ?? undefined,
        uiDisplayedStatus: result.uiResult?.displayedStatus || undefined,
        uiDisplayedRejection: result.uiResult?.displayedRejectionCode || undefined,
        uiStatus: result.uiResult?.status || undefined,
        uiDurationMs: result.uiResult?.durationMs || undefined,
        executedAt: new Date(),
      });

      onLog?.(
        `[TEST-RUNNER] ${result.passed ? '✅' : '❌'
        } ${tc.testId} → ${result.actualStatus}`
      );

      await this.sleep(800);
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // Run Single Test
  // ─────────────────────────────────────────────────────────────
  private async runSingle(
    tc: TestCase,
    sessionId: string,
    sessionDbName: string,
    dbSummary: DbSummary,
    screenshotsDir: string,
    onLog?: (msg: string) => void
  ): Promise<TestResult> {

    const startTime = Date.now();
    const tcpPort = 3000;      // ✅ correct — this is the PLC barcode TCP server
    const vmHost = this.resolveVmHost();
    const barcode =
      tc.barcode || this.generateBarcode();

    const machine =
      dbSummary.machines.find(
        (m) =>
          m.id === tc.machineId ||
          (m as any).machine_key === tc.machineName
      ) || dbSummary.machines[0];

    const machineName = machine?.name || 'Unknown';

    const machineKey =
      tc.machineName ||
      (machine as any)?.machine_key ||
      'MA01';

    let simulation: SimulationResult | null = null;
    let validation: ValidationResult | null = null;
    let uiResult: any | null = null;

    try {

      onLog?.(
        `  [TCP] Connecting to ${vmHost}:${tcpPort}`
      );

      const dims =
        tc.dims ?? { l: 187, b: 172, h: 47 };

      const weight = tc.weight ?? 0.12;

      // DUPLICATE TEST
      if (tc.isDuplicate) {

        await simulateOnInfra({
          barcode: tc.barcode,
          machineKey,
          dims,
          weight,
          edgeProfile: 'NORMAL',
          options: {
            host: vmHost,
            port: tcpPort,
          },
        });

        await this.sleep(1000);

        const secondRaw = await simulateOnInfra({
          barcode: tc.barcode,
          machineKey,
          dims,
          weight,
          edgeProfile: 'NORMAL',
          options: {
            host: vmHost,
            port: tcpPort,
          },
        });

        const second =
          secondRaw as unknown as SimulationResult;

        const {
          pbResponse,
          pdResponse,
          pcResponse,
        } = extractResponses(second);

        const allResponses = [
          pbResponse,
          pdResponse,
          pcResponse,
        ]
          .filter(Boolean)
          .join(' ');

        const gotDupr =
          allResponses.includes('DUPR') ||
          second.rejectionCode === 'DUPR';

        return {
          testId: tc.testId,
          scenario: tc.scenario,
          barcode,
          machineName,
          expectedStatus: tc.expectedStatus,
          actualStatus: gotDupr ? 'PASS' : 'FAIL',
          passed: gotDupr,
          simulation: second,
          validation: null,
          uiResult: null,
          durationMs: Date.now() - startTime,
          reason: gotDupr
            ? 'Got expected DUPR'
            : `Expected DUPR, got: ${allResponses}`,
        };
      }

      // NORMAL TEST
      const simRaw = await simulateOnInfra({
        barcode,
        machineKey,
        dims,
        weight,
        edgeProfile: 'NORMAL',
        options: {
          host: vmHost,
          port: tcpPort,
        },
      });

      simulation =
        simRaw as unknown as SimulationResult;

      const {
        pbResponse,
        pdResponse,
        pcResponse,
      } = extractResponses(simulation);

      onLog?.(
        `  [PHASE 1] PB:${pbResponse} PD:${pdResponse} PC:${pcResponse}`
      );

      await this.sleep(6000);

      // BACKEND VALIDATION
      const validator = new BackendValidator(this.mongoUri, 'sorting_service');

      validation = await validator.validateParcel(
        barcode,
        10,
        2000
      );

      // UI VALIDATION
      try {

        const commitId =
          (tc as any).commitId || 'latest';

        const apiResponse = {
          status: validation?.overallPass
            ? 'PASS'
            : 'FAIL',
        };

        uiResult =
          await this.uiValidator.validateParcelDisplay(
            `http://${process.env.VM_HOST}:7001/CL0003/master_search.php`,
            barcode,
            sessionId,
            commitId,
            apiResponse
          );

      } catch (uiErr: any) {

        uiResult = {
          found: false,
          error: uiErr.message,
          status: 'ERROR',
        };
      }

      const backendPassed =
        validation.overallPass;

      const actualStatus: 'PASS' | 'FAIL' =
        backendPassed ? 'PASS' : 'FAIL';

      return {
        testId: tc.testId,
        scenario: tc.scenario,
        barcode,
        machineName,
        expectedStatus: tc.expectedStatus,
        actualStatus,
        passed:
          actualStatus === tc.expectedStatus,
        simulation,
        validation,
        uiResult,
        durationMs: Date.now() - startTime,
      };

    } catch (err: any) {

      logger.error(
        `[TEST-RUNNER] ${tc.testId} crashed: ${err.message}`,
        'TEST-RUNNER'
      );

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
        error: err.message,
      };
    }
  }

  private generateBarcode(): string {
    const prefixes = ['VL', 'VAL'];

    const prefix =
      prefixes[Math.floor(Math.random() * prefixes.length)];

    const num = Math.floor(
      Math.random() * 9999999999999
    )
      .toString()
      .padStart(13, '0');

    return `${prefix}${num}`.slice(0, 16);
  }

  async assembleFinalReport(
    sessionId: string,
    machineId: string,
    commits: { beCommit?: string; feCommit?: string },
    env: any,
    perf: any,
    sessionStatus: any,
    alerts: any[],
    recommendations: string[],
    testResults: any[]
  ): Promise<any> {
    const total = testResults.length;
    const pass = testResults.filter(r => r.status === 'PASS').length;
    const fail = testResults.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length;
    const healed = testResults.filter(r => r.status === 'HEALED').length;

    const steps = testResults.map(r => ({
      step_id: r.testId || r.barcode,
      action: r.service || 'UI Validation',
      expected: 'PASS',
      actual: r.status,
      latency_ms: r.durationMs || 0,
      reason: r.reason || 'Verification complete'
    }));

    return {
      test_run_id: sessionId,
      execution: {
        summary: { total, pass, fail, healed },
        steps
      },
      infra: {
        machine_id: machineId,
        os: env.os,
        memory: env.memory,
        commits
      },
      performance: perf,
      root_causes: recommendations.length > 0 ? recommendations : (fail > 0 ? ['Infrastructure instability detected', 'Potential DB mismatch'] : []),
      session_status: sessionStatus
    };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}