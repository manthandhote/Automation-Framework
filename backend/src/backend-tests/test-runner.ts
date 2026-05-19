import path from 'path';
import fs from 'fs';
import * as net from 'net';
import { simulateOnInfra } from '../index';
import { BackendValidator, ValidationResult } from './validator';
import { UIValidator } from '../frontend-tests/ui-validator';
import { InspectraDB } from '../core/inspectra-db';
import { logger } from '../core/logger';
import { DbSummary, MachineInfo } from '../core/db-analyzer';

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

// ── Extract the 4-letter sort code from a PB response string ─────────────────
//
// PB response format: "MA01,1831,PB,1001,1003,SUCC"
//                                               ^^^^  ← last comma-segment
// Returns null if the response is empty or unparseable.

function extractSortCode(pbResponse: string): string | null {
  if (!pbResponse) return null;
  const parts = pbResponse.trim().split(',');
  const last = parts[parts.length - 1]?.trim();
  return last && /^[A-Z]{4}$/.test(last) ? last : null;
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
    if (match?.[1]) return match[1];
    return process.env.VM_HOST || '127.0.0.1';
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for a single TCP port
  // ─────────────────────────────────────────────────────────────
  private async waitForPort(
    host: string, port: number,
    timeoutMs = 120000,   // ← increased from 60000
    intervalMs = 2000,    // ← poll every 2s instead of 1s (less noise)
    label = `${host}:${port}`,
    onLog?: (msg: string) => void
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      const ready = await new Promise<boolean>((resolve) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
        sock.connect(port, host, () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on('error', () => { clearTimeout(timer); resolve(false); });
      });

      if (ready) {
        onLog?.(`  [READY] ${label} is up (attempt ${attempt})`);
        return;
      }

      // Log every 30s so output isn't spammy for 8 machines × 2 services = 16 streams
      const remaining = Math.round((deadline - Date.now()) / 1000);
      if (attempt === 1 || remaining % 30 === 0) {
        onLog?.(`  [WAIT] ${label} not ready (${remaining}s left)`);
      }

      await this.sleep(intervalMs);
    }
    throw new Error(`Timeout waiting for ${label}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for ALL machines' per-machine services
  //
  // All ports checked in parallel (Promise.all).
  // Duplicate ports deduplicated so we don't double-wait.
  // Timeout: 120s per port (set above).
  // ─────────────────────────────────────────────────────────────
  private async waitForAllServices(
    machines: MachineInfo[],
    onLog?: (msg: string) => void
  ): Promise<void> {
    onLog?.('  [STARTUP] Waiting for all services to be ready...');
    const vmHost = this.resolveVmHost();
    const activeMachines = machines.filter(m => m.status);

    onLog?.(`  [STARTUP] Checking ${activeMachines.length} machine(s) × 2 ports = ${activeMachines.length * 2} checks (parallel)`);

    const checks: Array<{ label: string; port: number }> = [];
    for (const machine of activeMachines) {
      checks.push({
        label: `app-device-interface [${machine.machine_key}] ${vmHost}:${machine.appDevicePort}`,
        port: machine.appDevicePort,
      });
      checks.push({
        label: `validation-engine [${machine.machine_key}] ${vmHost}:${machine.validationEnginePort}`,
        port: machine.validationEnginePort,
      });
    }

    // Deduplicate by port
    const seen = new Set<number>();
    const uniqueChecks = checks.filter(c => {
      if (seen.has(c.port)) return false;
      seen.add(c.port);
      return true;
    });

    // All checks run in parallel — Promise.all throws on first failure
    await Promise.all(
      uniqueChecks.map(({ label, port }) =>
        this.waitForPort(vmHost, port, 120000, 2000, label, onLog)
      )
    );

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

    const runsDir = path.join(this.workspacePath, 'runs', `run_${sessionId}`);
    const screenshotsDir = path.join(runsDir, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

    onLog?.(`[TEST-RUNNER] Starting ${testCases.length} test cases`);

    // Wait for all per-machine services before starting any test
    await this.waitForAllServices(dbSummary.machines, onLog);

    const results: TestResult[] = [];

    for (const tc of testCases) {
      onLog?.(`[TEST-RUNNER] ▶ Running ${tc.testId}: ${tc.description}`);
      const result = await this.runSingle(tc, sessionId, dbSummary, screenshotsDir, onLog);
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
        reason: result.reason || result.error ||
          (result.passed
            ? `Expected ${tc.expectedSortCode} → Got ${tc.expectedSortCode} ✅`
            : `Expected ${tc.expectedSortCode} → Got actual sort code ❌`),
        trace: result.validation ? {
          ingestion: result.validation.layer1_ingestion.found,
          sorting: result.validation.layer2_sorting.found,
          integration: result.validation.layer3_integration.found,
        } : null,
        uiFound: result.uiResult?.found ?? undefined,
        uiDisplayedStatus: result.uiResult?.displayedStatus || undefined,
        uiDisplayedRejection: result.uiResult?.displayedRejectionCode || undefined,
        uiStatus: result.uiResult?.status || undefined,
        uiDurationMs: result.uiResult?.durationMs || undefined,
        executedAt: new Date(),
      });

      onLog?.(`[TEST-RUNNER] ${result.passed ? '✅' : '❌'} ${tc.testId} → ${result.passed ? 'passed' : 'failed'} | expected: ${tc.expectedSortCode ?? tc.expectedStatus} | actual: ${result.reason}`);
      await this.sleep(800);
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // Run Single Test
  // ─────────────────────────────────────────────────────────────
  private async runSingle(
    tc: TestCase, sessionId: string, dbSummary: DbSummary,
    screenshotsDir: string, onLog?: (msg: string) => void
  ): Promise<TestResult> {

    const startTime = Date.now();
    const vmHost = this.resolveVmHost();
    const barcode = tc.barcode || this.generateBarcode();

    // ── Resolve the machine for this test case ────────────────────────────
    // Match by machineId first, then by machine_key (machineName field stores machine_key)
    const machine: MachineInfo =
      dbSummary.machines.find(m => m.id === tc.machineId) ||
      dbSummary.machines.find(m => m.machine_key === tc.machineName) ||
      dbSummary.machines[0];

    const machineName = machine?.name || 'Unknown';
    const machineKey = tc.machineName || machine?.machine_key || 'MA01';

    // ── Per-machine ports ─────────────────────────────────────────────────
    // tcpPort:    the TCP server port the scanner/PLC connects to on the VM
    //             → this is what PB/PD/PC packets are sent to
    //             → each machine has its own port (e.g. MA01=3001, MA02=3002)
    // appDevicePort / validationEnginePort: used for health checks (already done)
    const tcpPort = machine?.tcpPort ?? 3000;

    onLog?.(`  [MACHINE] ${machineKey} | TCP:${tcpPort} | appDevice:${machine?.appDevicePort} | validation:${machine?.validationEnginePort}`);

    let simulation: SimulationResult | null = null;
    let validation: ValidationResult | null = null;
    let uiResult: any | null = null;

    const validator = new BackendValidator(this.mongoUri);

    try {
      onLog?.(`  [TCP] Connecting to ${vmHost}:${tcpPort}`);

      const dims = tc.dims ?? { l: 187, b: 172, h: 47 };
      const weight = tc.weight ?? 0.12;

      // ─── DUPLICATE TEST (DUPR) ─────────────────────────────────────────
      if (tc.isDuplicate) {
        const secondRaw = await simulateOnInfra({
          barcode: tc.barcode,
          machineKey,
          dims,
          weight,
          edgeProfile: 'NORMAL',
          options: { host: vmHost, port: tcpPort },
        });

        const second = secondRaw as unknown as SimulationResult;
        simulation = second;

        const { pbResponse, pdResponse, pcResponse } = extractResponses(second);
        onLog?.(`  [PHASE 1] PB:${pbResponse} PD:${pdResponse} PC:${pcResponse}`);

        const actualSortCode = extractSortCode(pbResponse);
        const expectedSortCode = tc.expectedSortCode ?? 'DUPR';
        onLog?.(`  [SORT-CODE] expected=${expectedSortCode} actual=${actualSortCode ?? 'UNKNOWN'}`);

        await this.sleep(6000);
        validation = await validator.validateParcel(barcode, 10, 2000);

        try {
          uiResult = await this.uiValidator.validateParcelDisplay(
            `http://${process.env.VM_HOST}:7001/CL0003/master_search.php`,
            barcode, sessionId, (tc as any).commitId || 'latest',
            { status: 'FAIL' },
            screenshotsDir
          );
        } catch (uiErr: any) {
          uiResult = { found: false, error: uiErr.message, status: 'ERROR' };
        }

        const passed = actualSortCode === expectedSortCode;
        const actualStatus: 'PASS' | 'FAIL' = actualSortCode === 'SUCC' ? 'PASS' : 'FAIL';

        return {
          testId: tc.testId, scenario: tc.scenario, barcode, machineName,
          expectedStatus: tc.expectedStatus, actualStatus, passed,
          simulation, validation, uiResult,
          durationMs: Date.now() - startTime,
          screenshotPath: uiResult?.screenshotPath,
          reason: passed
            ? `${expectedSortCode} ✅`
            : `expected ${expectedSortCode} → got ${actualSortCode ?? 'UNKNOWN'} ❌`,
        };
      }

      // ─── NORMAL TEST ───────────────────────────────────────────────────
      const simRaw = await simulateOnInfra({
        barcode, machineKey, dims, weight,
        edgeProfile: 'NORMAL',
        options: { host: vmHost, port: tcpPort },  // ← per-machine TCP port
      });

      simulation = simRaw as unknown as SimulationResult;

      const { pbResponse, pdResponse, pcResponse } = extractResponses(simulation);
      onLog?.(`  [PHASE 1] PB:${pbResponse} PD:${pdResponse} PC:${pcResponse}`);

      // ── SOURCE OF TRUTH: sort code from TCP PB response ───────────────
      const actualSortCode = extractSortCode(pbResponse);
      const expectedSortCode = tc.expectedSortCode;
      onLog?.(`  [SORT-CODE] expected=${expectedSortCode ?? 'N/A'} actual=${actualSortCode ?? 'UNKNOWN'}`);

      await this.sleep(6000);

      // Validator and UI are trace-only — do NOT affect passed
      validation = await validator.validateParcel(barcode, 10, 2000);

      try {
        uiResult = await this.uiValidator.validateParcelDisplay(
          `http://${process.env.VM_HOST}:7001/CL0003/master_search.php`,
          barcode, sessionId, (tc as any).commitId || 'latest',
          { status: actualSortCode === 'SUCC' ? 'PASS' : 'FAIL' },
          screenshotsDir
        );
      } catch (uiErr: any) {
        uiResult = { found: false, error: uiErr.message, status: 'ERROR' };
      }

      // ── PASS/FAIL: sort code match only ────────────────────────────────
      let passed: boolean;
      let actualStatus: 'PASS' | 'FAIL';
      let reason: string;

      if (expectedSortCode) {
        passed = actualSortCode === expectedSortCode;
        actualStatus = actualSortCode === 'SUCC' ? 'PASS' : 'FAIL';
        reason = passed
          ? `${expectedSortCode} ✅`
          : `expected ${expectedSortCode} → got ${actualSortCode ?? 'UNKNOWN'} ❌`;
      } else {
        // Legacy fallback: use validator.overallPass
        const rejectionCode = simulation?.rejectionCode
          || simulation?.steps.find(s => s.type === 'PB')?.response?.match(/,([A-Z]{4})\s/)?.[1]
          || null;
        actualStatus = validation.overallPass && !rejectionCode ? 'PASS' : 'FAIL';
        passed = actualStatus === tc.expectedStatus;
        reason = passed
          ? `Expected ${tc.expectedStatus} → Got ${actualStatus} ✅`
          : `Expected ${tc.expectedStatus} → Got ${actualStatus} ❌${rejectionCode ? ` (${rejectionCode})` : ''}`;
      }

      // ── UI note (informational only) ────────────────────────────────────
      const uiRejectionCode = uiResult?.displayedRejectionCode || null;
      const uiDisplayedStatus = uiResult?.displayedStatus || null;
      let uiNote = '';

      if (uiResult?.found) {
        if (actualSortCode && actualSortCode !== 'SUCC') {
          const uiCorrect = uiRejectionCode === actualSortCode;
          uiNote = uiCorrect
            ? `UI shows ${uiRejectionCode} ✅`
            : `UI shows "${uiRejectionCode ?? uiDisplayedStatus}" (machine: ${actualSortCode})`;
        } else if (actualSortCode === 'SUCC') {
          const uiCorrect = uiDisplayedStatus !== 'Rejected';
          uiNote = uiCorrect ? `UI shows success ✅` : `UI shows Rejected but machine sorted ⚠️`;
        }
      } else {
        uiNote = `barcode not found on UI`;
      }

      if (uiNote) reason += ` | UI: ${uiNote}`;

      return {
        testId: tc.testId, scenario: tc.scenario, barcode, machineName,
        expectedStatus: tc.expectedStatus, actualStatus, passed,
        simulation, validation, uiResult,
        durationMs: Date.now() - startTime,
        screenshotPath: uiResult?.screenshotPath,
        reason,
      };

    } catch (err: any) {
      logger.error(`[TEST-RUNNER] ${tc.testId} crashed: ${err.message}`, 'TEST-RUNNER');
      return {
        testId: tc.testId, scenario: tc.scenario, barcode, machineName,
        expectedStatus: tc.expectedStatus, actualStatus: 'ERROR', passed: false,
        simulation, validation, uiResult,
        durationMs: Date.now() - startTime,
        error: err.message,
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
    sessionId: string, machineId: string,
    commits: { beCommit?: string; feCommit?: string },
    env: any, perf: any, sessionStatus: any,
    alerts: any[], recommendations: string[], testResults: any[]
  ): Promise<any> {
    const total = testResults.length;
    const pass = testResults.filter(r => r.status === 'PASS').length;
    const fail = testResults.filter(r => r.status === 'FAIL' || r.status === 'ERROR').length;
    const healed = testResults.filter(r => r.status === 'HEALED').length;

    return {
      test_run_id: sessionId,
      execution: {
        summary: { total, pass, fail, healed },
        steps: testResults.map(r => ({
          step_id: r.testId || r.barcode,
          action: r.service || 'UI Validation',
          expected: 'PASS',
          actual: r.status,
          latency_ms: r.durationMs || 0,
          reason: r.reason || 'Verification complete'
        }))
      },
      infra: { machine_id: machineId, os: env.os, memory: env.memory, commits },
      performance: perf,
      root_causes: recommendations.length > 0
        ? recommendations
        : (fail > 0 ? ['Infrastructure instability detected', 'Potential DB mismatch'] : []),
      session_status: sessionStatus
    };
  }

  private sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}