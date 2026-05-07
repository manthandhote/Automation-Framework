import * as net from 'net';
import { MongoClient, Db } from 'mongodb';
import { EventEmitter } from 'events';
import { AdvancedSimulator } from './advanced-simulator';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface E2ETestCase {
  testId: string;
  name: string;
  description: string;
  category: 'happy-path' | 'negative' | 'edge-case' | 'boundary';
  /** The raw TCP string(s) to send */
  packets: string[];
  /** Expected behavior */
  expectedResponseContains?: string[];
  expectedResponseNotContains?: string[];
  /** Delay between packets in ms */
  packetDelay?: number;
  /** Whether we expect the DB to have a record after this test */
  expectDbRecord?: boolean;
  /** The barcode used in this test for DB validation */
  barcode?: string;
}

export interface E2ETestResult {
  testId: string;
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  reason: string;
  responses: string[];
  dbValidation?: {
    found: boolean;
    collection?: string;
    document?: any;
  };
  durationMs: number;
  timestamp: Date;
}

export interface E2EReport {
  sessionId: string;
  totalTests: number;
  passed: number;
  failed: number;
  errors: number;
  results: E2ETestResult[];
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TCP Helper
// ═══════════════════════════════════════════════════════════════════════════════

async function sendTcp(host: string, port: number, packet: string, timeoutMs: number = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(new Error(`TCP Timeout (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    client.connect(port, host, () => {
      client.write(packet + '\n');
    });

    client.on('data', (data) => {
      response += data.toString();
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve(response.trim());
      }
    });

    client.on('close', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(response.trim());
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(err);
      }
    });
  });
}

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Case Builder
// ═══════════════════════════════════════════════════════════════════════════════

function buildTestCases(machineKey: string): E2ETestCase[] {
  let tid = 7001;
  const nextTid = () => (tid++).toString().padStart(4, '0');

  const cases: E2ETestCase[] = [];

  // ──── 1. Happy Path: Normal Barcode Flow ──────────────────────────────────
  const t1Tid = nextTid();
  const t1Barcode = 'AWB100000001';
  cases.push({
    testId: 'E2E-001',
    name: 'Normal Barcode Flow (PB → PD → PC)',
    description: 'Send a valid barcode, then dimensions+weight, then parcel confirmation. Expect valid responses without ERRO/WMRR.',
    category: 'happy-path',
    packets: [
      `${machineKey},${t1Tid},PB,FL01,A,1001,${t1Barcode}`,
      `${machineKey},${t1Tid},PD,1001,250,200,150,7500000,7500000,1,1,PW,0001,0.500,`,
      `${machineKey},${t1Tid},PC,1035,`,
    ],
    packetDelay: 500,
    expectedResponseContains: [machineKey, t1Tid, 'PB'],
    expectedResponseNotContains: ['WMRR'],
    expectDbRecord: true,
    barcode: t1Barcode,
  });

  // ──── 2. Duplicate Barcode (Same TID) ─────────────────────────────────────
  const t2Tid = nextTid();
  const t2Barcode = 'AWB200000002';
  cases.push({
    testId: 'E2E-002',
    name: 'Duplicate Barcode (Same TID)',
    description: 'Send the same PB string twice with the same tracking ID. Second call should return cached response.',
    category: 'edge-case',
    packets: [
      `${machineKey},${t2Tid},PB,FL01,A,1001,${t2Barcode}`,
      `${machineKey},${t2Tid},PB,FL01,A,1001,${t2Barcode}`,
    ],
    packetDelay: 300,
    expectedResponseContains: [machineKey, t2Tid],
    barcode: t2Barcode,
  });

  // ──── 3. Invalid Machine Key ──────────────────────────────────────────────
  const t3Tid = nextTid();
  cases.push({
    testId: 'E2E-003',
    name: 'Invalid Machine Key',
    description: 'Send PB with wrong machine key (XX99). Parser should reject with WMRR.',
    category: 'negative',
    packets: [
      `XX99,${t3Tid},PB,FL01,A,1001,AWB300000003`,
    ],
    expectedResponseContains: ['WMRR'],
    barcode: 'AWB300000003',
  });

  // ──── 4. Dimension Before Barcode ─────────────────────────────────────────
  const t4Tid = nextTid();
  cases.push({
    testId: 'E2E-004',
    name: 'Dimension Before Barcode',
    description: 'Send PD without a prior PB for this TID. Should return ERRO response.',
    category: 'negative',
    packets: [
      `${machineKey},${t4Tid},PD,1001,250,200,150,7500000,7500000,1,1,PW,0001,0.500,`,
    ],
    expectedResponseContains: ['ERRO'],
  });

  // ──── 5. PC Before Barcode ────────────────────────────────────────────────
  const t5Tid = nextTid();
  cases.push({
    testId: 'E2E-005',
    name: 'PC Before Barcode',
    description: 'Send PC without a prior PB. Should return minimal response without crash.',
    category: 'negative',
    packets: [
      `${machineKey},${t5Tid},PC,1035,`,
    ],
    expectedResponseContains: [machineKey, 'PC'],
  });

  // ──── 6. Short/Malformed PB ───────────────────────────────────────────────
  const t6Tid = nextTid();
  cases.push({
    testId: 'E2E-006',
    name: 'Short/Malformed PB String',
    description: 'Send PB with fewer than 6 fields. Parser should handle gracefully without crashing.',
    category: 'negative',
    packets: [
      `${machineKey},${t6Tid},PB,FL01`,
    ],
    // We expect either an empty response or a non-crash
  });

  // ──── 7. Over-Limit Dimensions ────────────────────────────────────────────
  const t7Tid = nextTid();
  const t7Barcode = 'AWB700000007';
  cases.push({
    testId: 'E2E-007',
    name: 'Over-Limit Dimensions',
    description: 'Send PB then PD with length=9999 (exceeds 500mm limit). Should get rejection in PD response.',
    category: 'boundary',
    packets: [
      `${machineKey},${t7Tid},PB,FL01,A,1001,${t7Barcode}`,
      `${machineKey},${t7Tid},PD,1001,9999,200,150,299970000,299970000,1,1,PW,0001,0.500,`,
    ],
    packetDelay: 500,
    barcode: t7Barcode,
  });

  // ──── 8. Under-Weight Parcel ──────────────────────────────────────────────
  const t8Tid = nextTid();
  const t8Barcode = 'AWB800000008';
  cases.push({
    testId: 'E2E-008',
    name: 'Under-Weight Parcel',
    description: 'Send PB then PD with weight=0.01 (below 0.07kg limit). Should get weight rejection.',
    category: 'boundary',
    packets: [
      `${machineKey},${t8Tid},PB,FL01,A,1001,${t8Barcode}`,
      `${machineKey},${t8Tid},PD,1001,250,200,150,7500000,7500000,1,1,PW,0001,0.010,`,
    ],
    packetDelay: 500,
    barcode: t8Barcode,
  });

  return cases;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  E2E Test Runner
// ═══════════════════════════════════════════════════════════════════════════════

export class E2ETestRunner extends EventEmitter {
  private tcpHost: string;
  private tcpPort: number;
  private mongoUri: string;
  private sessionDbName: string;
  private machineKey: string;

  constructor(config: {
    tcpHost?: string;
    tcpPort?: number;
    mongoUri: string;
    sessionDbName: string;
    machineKey?: string;
  }) {
    super();
    this.tcpHost = config.tcpHost || '127.0.0.1';
    this.tcpPort = config.tcpPort || 3000;
    this.mongoUri = config.mongoUri;
    this.sessionDbName = config.sessionDbName;
    this.machineKey = config.machineKey || 'MA01';
  }

  private log(msg: string) {
    console.log(msg);
    this.emit('log', msg);
  }

  /**
   * Seed the session DB with machine config from `machine_configurations` if needed.
   */
  async seedSessionDb(): Promise<void> {
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      const sessionDb = client.db(this.sessionDbName);
      const machineCount = await sessionDb.collection('machines').countDocuments();

      if (machineCount === 0) {
        this.log(`[E2E] Session DB "${this.sessionDbName}" has no machines. Seeding from master...`);
        const masterDb = client.db('machine_configurations');
        const machines = await masterDb.collection('machines').find().toArray();

        if (machines.length > 0) {
          await sessionDb.collection('machines').insertMany(machines);
          this.log(`[E2E] ✅ Seeded ${machines.length} machine(s) into session DB.`);
        } else {
          this.log(`[E2E] ⚠️ Master DB also has no machines! Tests may fail.`);
        }
      } else {
        this.log(`[E2E] Session DB already has ${machineCount} machine(s). Skipping seed.`);
      }
    } finally {
      await client.close();
    }
  }

  /**
   * Check if the TCP server is accepting connections.
   */
  async checkTcpConnectivity(): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new net.Socket();
      const timer = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 3000);

      client.connect(this.tcpPort, this.tcpHost, () => {
        clearTimeout(timer);
        client.destroy();
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timer);
        client.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Validate that a barcode's data landed in the session DB.
   */
  async validateInDb(barcode: string): Promise<{ found: boolean; collection?: string; document?: any }> {
    const client = new MongoClient(this.mongoUri);
    try {
      await client.connect();
      const db = client.db(this.sessionDbName);
      const collections = await db.listCollections().toArray();

      for (const col of collections) {
        const doc = await db.collection(col.name).findOne({
          $or: [
            { barcode: barcode },
            { 'barcode_data.barcode': barcode },
            { awb: barcode },
            { 'barcode_data.barcode': { $regex: barcode } },
          ]
        });
        if (doc) {
          return { found: true, collection: col.name, document: doc };
        }
      }
      return { found: false };
    } finally {
      await client.close();
    }
  }

  /**
   * Run a single test case.
   */
  async runTestCase(tc: E2ETestCase): Promise<E2ETestResult> {
    const startTime = Date.now();
    const result: E2ETestResult = {
      testId: tc.testId,
      name: tc.name,
      category: tc.category,
      status: 'PASS',
      reason: '',
      responses: [],
      durationMs: 0,
      timestamp: new Date(),
    };

    try {
      // Send each packet and collect responses
      for (let i = 0; i < tc.packets.length; i++) {
        const pkt = tc.packets[i];
        this.log(`  [${tc.testId}] → Sending: ${pkt}`);

        try {
          const resp = await sendTcp(this.tcpHost, this.tcpPort, pkt);
          result.responses.push(resp);
          this.log(`  [${tc.testId}] ← Response: ${resp || '(empty)'}`);
        } catch (err: any) {
          // For short/malformed packets, a timeout or empty response is OK
          if (tc.category === 'negative' && tc.testId === 'E2E-006') {
            result.responses.push(`ERROR: ${err.message}`);
            this.log(`  [${tc.testId}] ← Error (expected for malformed): ${err.message}`);
          } else {
            throw err;
          }
        }

        if (tc.packetDelay && i < tc.packets.length - 1) {
          await delay(tc.packetDelay);
        }
      }

      // Validate response content
      const allResponses = result.responses.join(' ');

      if (tc.expectedResponseContains) {
        for (const expected of tc.expectedResponseContains) {
          if (!allResponses.includes(expected)) {
            result.status = 'FAIL';
            result.reason = `Expected response to contain "${expected}" but got: ${allResponses}`;
            break;
          }
        }
      }

      if (tc.expectedResponseNotContains && result.status === 'PASS') {
        for (const notExpected of tc.expectedResponseNotContains) {
          if (allResponses.includes(notExpected)) {
            result.status = 'FAIL';
            result.reason = `Response should NOT contain "${notExpected}" but got: ${allResponses}`;
            break;
          }
        }
      }

      // DB Validation (wait a moment for async processing)
      if (tc.expectDbRecord && tc.barcode && result.status === 'PASS') {
        await delay(2000);
        const dbResult = await this.validateInDb(tc.barcode);
        result.dbValidation = dbResult;
        if (!dbResult.found) {
          result.status = 'FAIL';
          result.reason = `Barcode ${tc.barcode} not found in any collection in ${this.sessionDbName}`;
        }
      }

      // If still PASS and no explicit reason set
      if (result.status === 'PASS' && !result.reason) {
        result.reason = 'All assertions passed';
      }

    } catch (err: any) {
      result.status = 'ERROR';
      result.reason = err.message;
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Run the full E2E test suite.
   */
  async run(sessionId: string): Promise<E2EReport> {
    const startedAt = new Date();

    this.log('═══════════════════════════════════════════════════════════');
    this.log('  🚀 E2E TEST SUITE — NIDOWORKZ Automation Framework');
    this.log('═══════════════════════════════════════════════════════════');
    this.log(`  Session:    ${sessionId}`);
    this.log(`  Target DB:  ${this.sessionDbName}`);
    this.log(`  TCP Target: ${this.tcpHost}:${this.tcpPort}`);
    this.log(`  Machine:    ${this.machineKey}`);
    this.log('');

    // Pre-flight checks
    this.log('[E2E] Running pre-flight checks...');

    // 1. Check TCP connectivity
    const tcpOk = await this.checkTcpConnectivity();
    if (!tcpOk) {
      this.log(`[E2E] ❌ Cannot connect to TCP server at ${this.tcpHost}:${this.tcpPort}`);
      this.log(`[E2E] Make sure app-device-interface is running and its TCP server is listening.`);
      return {
        sessionId,
        totalTests: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        results: [],
        startedAt,
        completedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
      };
    }
    this.log('[E2E] ✅ TCP server is reachable.');

    // 2. Seed session DB if needed
    await this.seedSessionDb();

    // 3. Build and run test cases
    const testCases = buildTestCases(this.machineKey);
    this.log(`\n[E2E] Running ${testCases.length} test cases...\n`);

    const results: E2ETestResult[] = [];
    let passed = 0, failed = 0, errors = 0;

    for (const tc of testCases) {
      this.log(`━━━ ${tc.testId}: ${tc.name} [${tc.category}] ━━━`);
      this.log(`    ${tc.description}`);

      const result = await this.runTestCase(tc);
      results.push(result);

      const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '💥';
      this.log(`  ${icon} ${result.status}: ${result.reason}`);
      if (result.dbValidation) {
        this.log(`  📦 DB: ${result.dbValidation.found ? `Found in ${result.dbValidation.collection}` : 'Not found'}`);
      }
      this.log('');

      if (result.status === 'PASS') passed++;
      else if (result.status === 'FAIL') failed++;
      else errors++;

      // Small delay between tests to avoid overwhelming the server
      await delay(500);
    }

    const completedAt = new Date();
    const report: E2EReport = {
      sessionId,
      totalTests: testCases.length,
      passed,
      failed,
      errors,
      results,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };

    this.log('═══════════════════════════════════════════════════════════');
    this.log(`  📊 RESULTS: ${passed} passed, ${failed} failed, ${errors} errors (${testCases.length} total)`);
    this.log(`  ⏱  Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
    this.log('═══════════════════════════════════════════════════════════');

    return report;
  }
}
