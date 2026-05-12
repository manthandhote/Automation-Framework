import * as net from 'net';
import { MongoClient } from 'mongodb';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

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

/**
 * Send a single TCP packet and wait for a response.
 * Resolves on first data received, or on connection close.
 */
async function sendTcp(
    host: string,
    port: number,
    packet: string,
    timeoutMs: number = 10000
): Promise<string> {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let response = '';
        let settled = false;

        const finish = (result: string | Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.destroy();
            if (result instanceof Error) reject(result);
            else resolve(result.trim());
        };

        const timer = setTimeout(() => {
            finish(new Error(`TCP timeout (${timeoutMs}ms) waiting for response to: ${packet}`));
        }, timeoutMs);

        client.connect(port, host, () => {
            client.write(packet + '\r\n');
        });

        client.on('data', (data) => {
            response += data.toString();
            finish(response);
        });

        client.on('close', () => {
            finish(response);
        });

        client.on('error', (err) => {
            finish(err);
        });
    });
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Response Parsers
//
//  PB response: MA01,<tid>,PB,<scan_id>,<controller_value>,<display>
//    accepted:  MA01,0003,PB,1001,1013,SUCC
//    rejected:  MA01,0002,PB,1001,9001,IBAR
//
//  PD response: MA01,<tid>,PD,<scan_id>,<ctrl>,PW,<pw_id>,<ctrl>,<display>
//    accepted:  MA01,0003,PD,1001,1013,PW,0001,1013,SUCC
//
//  PC response: MA01,<tid>,PC
// ═══════════════════════════════════════════════════════════════════════════════

function parsePbResponse(raw: string): {
    tid: string; controllerValue: string; display: string; accepted: boolean;
} | null {
    const parts = raw.trim().split(',');
    if (parts.length < 6 || parts[2] !== 'PB') return null;
    return {
        tid: parts[1],
        controllerValue: parts[4],
        display: parts[5],
        accepted: parts[5] === 'SUCC',
    };
}

function parsePdResponse(raw: string): {
    tid: string; display: string; accepted: boolean;
} | null {
    const parts = raw.trim().split(',');
    if (parts.length < 9 || parts[2] !== 'PD') return null;
    return {
        tid: parts[1],
        display: parts[8],
        accepted: parts[8] === 'SUCC',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Case Definitions
// ═══════════════════════════════════════════════════════════════════════════════

interface DimDef {
    length: string;
    width: string;
    height: string;
    volume: string;
    realVolume: string;
    count: string;
    parcels: string;
    pwId: string;
    weight: string;   // in KG e.g. "0.12"
}

interface E2ETestDef {
    testId: string;
    name: string;
    category: 'happy-path' | 'negative' | 'edge-case' | 'boundary';
    description: string;
    barcode: string;
    tid: string;
    dimensions?: DimDef;
    machineKeyOverride?: string;
    /** If set, assert PB display matches exactly */
    expectPbDisplay?: string;
    /** If true, assert PB is accepted; if false, assert rejected and stop chain */
    expectPbAccepted?: boolean;
    /** If true, boundary test expects PD to be rejected */
    expectPdRejected?: boolean;
    expectDbRecord?: boolean;
    /** If true, send PB twice to test cache */
    sendDuplicatePb?: boolean;
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

    // ── Packet builders ────────────────────────────────────────────────────────

    /** PB: MA01,<tid>,PB,FL01,A,1001,<barcode> */
    private pb(tid: string, barcode: string, mk = this.machineKey): string {
        return `${mk},${tid},PB,FL01,A,1001,${barcode}`;
    }

    /**
     * PD+PW combined (exactly as machine sends):
     * MA01,<tid>,PD,1001,<l>,<w>,<h>,<vol>,<realvol>,<cnt>,<parcels>,PW,<pwId>,<weight padded 15>,
     *
     * The weight field is right-padded to 15 chars with leading spaces, followed by a trailing comma.
     * This matches what Hercules shows: "PW,0001,               0.12,"
     */
    private pd(tid: string, d: DimDef, mk = this.machineKey): string {
        const weightPadded = d.weight.padStart(15);
        return `${mk},${tid},PD,1001,${d.length},${d.width},${d.height},${d.volume},${d.realVolume},${d.count},${d.parcels},PW,${d.pwId},${weightPadded},`;
    }

    /**
     * PC: MA01,<tid>,PC,<sortLocation>
     * sortLocation = controller_value from PB response (the bin number e.g. "1013")
     */
    private pc(tid: string, sortLocation: string, mk = this.machineKey): string {
        return `${mk},${tid},PC,${sortLocation}`;
    }

    // ── Test case list ─────────────────────────────────────────────────────────

    private buildTestCases(): E2ETestDef[] {
        const stdDims: DimDef = {
            length: '187', width: '172', height: '47',
            volume: '1519622', realVolume: '1010378',
            count: '1', parcels: '1',
            pwId: '0001', weight: '0.12',
        };

        return [
            // ── TC-001: Full happy path ────────────────────────────────────────────
            {
                testId: 'E2E-001',
                name: 'Full happy path — VL barcode → SUCC sorted',
                category: 'happy-path',
                description: 'Valid VL barcode, valid dims/weight. Expect PB=SUCC → PD=SUCC → PC ack → DB record.',
                barcode: 'VL0084016900365',
                tid: '0011',
                dimensions: stdDims,
                expectPbAccepted: true,
                expectDbRecord: true,
            },

            // ── TC-002: IBAR — regex mismatch ─────────────────────────────────────
            {
                testId: 'E2E-002',
                name: 'Rejected barcode — regex mismatch (IBAR)',
                category: 'negative',
                description: '"164gdhvd" does not match barcode regex → expect IBAR, stop after PB.',
                barcode: '164gdhvd',
                tid: '0012',
                expectPbAccepted: false,
                expectPbDisplay: 'IBAR',
            },

            // ── TC-003: Duplicate PB same TID — cached SUCC ───────────────────────
            {
                testId: 'E2E-003',
                name: 'Duplicate PB same TID — cached SUCC response',
                category: 'edge-case',
                description: 'Send same PB string twice. Second should return cached SUCC.',
                barcode: 'VL008401690462',
                tid: '0013',
                dimensions: stdDims,
                expectPbAccepted: true,
                sendDuplicatePb: true,
                expectDbRecord: true,
            },

            // ── TC-004: Wrong machine key ──────────────────────────────────────────
            {
                testId: 'E2E-004',
                name: 'Invalid machine key → rejected',
                category: 'negative',
                description: 'PB with machine key XX99. Parser should reject or timeout.',
                barcode: 'VL008401234561',
                tid: '0014',
                machineKeyOverride: 'XX99',
                expectPbAccepted: false,
            },

            // ── TC-005: Over-limit dimension (LOLR) ───────────────────────────────
            {
                testId: 'E2E-005',
                name: 'Over-limit length → PD rejected (LOLR)',
                category: 'boundary',
                description: 'Length=9999mm exceeds 500mm limit. PB accepted, PD should be rejected.',
                barcode: 'VL008401690123',
                tid: '0015',
                dimensions: {
                    length: '9999', width: '172', height: '47',
                    volume: '299970000', realVolume: '299970000',
                    count: '1', parcels: '1',
                    pwId: '0001', weight: '0.12',
                },
                expectPbAccepted: true,
                expectPdRejected: true,
                expectDbRecord: true,
            },

            // ── TC-006: Under-weight (WULR) ───────────────────────────────────────
            {
                testId: 'E2E-006',
                name: 'Under-weight parcel → PD rejected (WULR)',
                category: 'boundary',
                description: 'Weight=0.01kg below 0.07kg limit. PB accepted, PD should be rejected.',
                barcode: 'VL008401690124',
                tid: '0016',
                dimensions: {
                    length: '187', width: '172', height: '47',
                    volume: '1519622', realVolume: '1010378',
                    count: '1', parcels: '1',
                    pwId: '0001', weight: '0.01',
                },
                expectPbAccepted: true,
                expectPdRejected: true,
                expectDbRecord: true,
            },
        ];
    }

    // ── Run one test case ──────────────────────────────────────────────────────

    private async runTest(def: E2ETestDef): Promise<E2ETestResult> {
        const startTime = Date.now();
        const responses: string[] = [];
        const mk = def.machineKeyOverride || this.machineKey;

        const result: E2ETestResult = {
            testId: def.testId,
            name: def.name,
            category: def.category,
            status: 'PASS',
            reason: '',
            responses,
            durationMs: 0,
            timestamp: new Date(),
        };

        try {
            // ── STEP 1: PB ─────────────────────────────────────────────────────────
            const pbPkt = this.pb(def.tid, def.barcode, mk);
            this.log(`  [${def.testId}] → PB: ${pbPkt}`);

            const pbRaw = await sendTcp(this.tcpHost, this.tcpPort, pbPkt, 10000);
            responses.push(pbRaw);
            this.log(`  [${def.testId}] ← PB: ${pbRaw || '(empty)'}`);

            const pbParsed = parsePbResponse(pbRaw);

            // Duplicate PB test — send again, assert same cached response
            if (def.sendDuplicatePb) {
                await sleep(300);
                const pbRaw2 = await sendTcp(this.tcpHost, this.tcpPort, pbPkt, 10000);
                responses.push(pbRaw2);
                this.log(`  [${def.testId}] ← PB (dup): ${pbRaw2 || '(empty)'}`);
                const pb2Parsed = parsePbResponse(pbRaw2);
                if (!pb2Parsed?.accepted) {
                    result.status = 'FAIL';
                    result.reason = `Duplicate PB: expected cached SUCC but got: ${pbRaw2}`;
                    result.durationMs = Date.now() - startTime;
                    return result;
                }
            }

            // Assert PB display if required
            if (def.expectPbDisplay !== undefined) {
                if (pbParsed?.display !== def.expectPbDisplay) {
                    result.status = 'FAIL';
                    result.reason = `Expected PB display '${def.expectPbDisplay}', got '${pbParsed?.display ?? '(unparsed)'}' — raw: ${pbRaw}`;
                    result.durationMs = Date.now() - startTime;
                    return result;
                }
            }

            // If we expect rejection, stop chain here
            if (def.expectPbAccepted === false) {
                if (pbParsed?.accepted) {
                    result.status = 'FAIL';
                    result.reason = `Expected PB rejection but got SUCC: ${pbRaw}`;
                } else {
                    result.status = 'PASS';
                    result.reason = `PB correctly rejected (${pbParsed?.display ?? pbRaw})`;
                }
                result.durationMs = Date.now() - startTime;
                return result;
            }

            // If PB not accepted when we expected it to be → FAIL, stop chain
            if (!pbParsed?.accepted) {
                result.status = 'FAIL';
                result.reason = `PB unexpectedly rejected: ${pbRaw}`;
                result.durationMs = Date.now() - startTime;
                return result;
            }

            // Store sort location from PB for PC step
            const sortLocation = pbParsed.controllerValue;

            // ── STEP 2: PD (only if PB accepted and dims provided) ─────────────────
            if (!def.dimensions) {
                result.reason = 'PB accepted. No PD defined.';
                result.durationMs = Date.now() - startTime;
                return result;
            }

            await sleep(400);

            const pdPkt = this.pd(def.tid, def.dimensions, mk);
            this.log(`  [${def.testId}] → PD: ${pdPkt}`);

            const pdRaw = await sendTcp(this.tcpHost, this.tcpPort, pdPkt, 10000);
            responses.push(pdRaw);
            this.log(`  [${def.testId}] ← PD: ${pdRaw || '(empty)'}`);

            const pdParsed = parsePdResponse(pdRaw);

            // If PD rejected
            if (!pdParsed?.accepted) {
                if (def.expectPdRejected) {
                    result.status = 'PASS';
                    result.reason = `PD correctly rejected (boundary test): ${pdRaw}`;
                } else {
                    result.status = 'FAIL';
                    result.reason = `PD unexpectedly rejected: ${pdRaw}`;
                }
                result.durationMs = Date.now() - startTime;
                return result;
            }

            // If we expected PD rejection but it was accepted → FAIL
            if (def.expectPdRejected && pdParsed.accepted) {
                result.status = 'FAIL';
                result.reason = `Expected PD rejection but got SUCC: ${pdRaw}`;
                result.durationMs = Date.now() - startTime;
                return result;
            }

            // ── STEP 3: PC (only if PD accepted) ───────────────────────────────────
            await sleep(400);

            const pcPkt = this.pc(def.tid, sortLocation, mk);
            this.log(`  [${def.testId}] → PC: ${pcPkt}`);

            const pcRaw = await sendTcp(this.tcpHost, this.tcpPort, pcPkt, 10000);
            responses.push(pcRaw);
            this.log(`  [${def.testId}] ← PC: ${pcRaw || '(empty)'}`);

            // PC response = MA01,<tid>,PC  (no extra fields)
            if (!pcRaw.includes(',PC')) {
                result.status = 'FAIL';
                result.reason = `Unexpected PC response: ${pcRaw}`;
                result.durationMs = Date.now() - startTime;
                return result;
            }

            // ── STEP 4: DB validation ──────────────────────────────────────────────
            if (def.expectDbRecord) {
                await sleep(2000);
                const dbResult = await this.validateInDb(def.barcode);
                result.dbValidation = dbResult;
                if (!dbResult.found) {
                    result.status = 'FAIL';
                    result.reason = `Barcode ${def.barcode} not found in DB after full PB→PD→PC cycle`;
                    result.durationMs = Date.now() - startTime;
                    return result;
                }
            }

            result.reason = 'Full PB→PD→PC cycle completed and validated ✓';

        } catch (err: any) {
            result.status = 'ERROR';
            result.reason = err.message;
        }

        result.durationMs = Date.now() - startTime;
        return result;
    }

    // ── DB validation ──────────────────────────────────────────────────────────

    async validateInDb(barcode: string): Promise<{ found: boolean; collection?: string; document?: any }> {
        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            // Check sorting_service first (primary_sortings), then incoming_service
            const dbs = ['sorting_service', 'incoming_service', this.sessionDbName];
            for (const dbName of dbs) {
                try {
                    const db = client.db(dbName);
                    const collections = await db.listCollections().toArray();
                    for (const col of collections) {
                        const doc = await db.collection(col.name).findOne({
                            $or: [
                                { barcode },
                                { 'barcode_data.scanned_barcode': barcode },
                                { awb: barcode },
                            ]
                        });
                        if (doc) return { found: true, collection: `${dbName}.${col.name}`, document: doc };
                    }
                } catch (_) { /* skip DB if not accessible */ }
            }
            return { found: false };
        } finally {
            await client.close();
        }
    }

    // ── TCP connectivity check ─────────────────────────────────────────────────

    async checkTcpConnectivity(): Promise<boolean> {
        return new Promise((resolve) => {
            const client = new net.Socket();
            const timer = setTimeout(() => { client.destroy(); resolve(false); }, 3000);
            client.connect(this.tcpPort, this.tcpHost, () => {
                clearTimeout(timer);
                client.destroy();
                resolve(true);
            });
            client.on('error', () => { clearTimeout(timer); resolve(false); });
        });
    }

    // ── Main run ───────────────────────────────────────────────────────────────

    async run(sessionId: string): Promise<E2EReport> {
        const startedAt = new Date();

        this.log('═══════════════════════════════════════════════════════════');
        this.log('  🚀  AUTOMYRIX E2E TEST SUITE');
        this.log('═══════════════════════════════════════════════════════════');
        this.log(`  Session:    ${sessionId}`);
        this.log(`  TCP Target: ${this.tcpHost}:${this.tcpPort}`);
        this.log(`  Machine:    ${this.machineKey}`);
        this.log('');

        this.log('[E2E] Checking TCP connectivity...');
        const tcpOk = await this.checkTcpConnectivity();
        if (!tcpOk) {
            this.log(`[E2E] ❌ Cannot reach TCP at ${this.tcpHost}:${this.tcpPort}`);
            this.log(`[E2E]    Make sure app-device-interface is running and TCP server is listening on port ${this.tcpPort}.`);
            return {
                sessionId, totalTests: 0, passed: 0, failed: 0, errors: 0,
                results: [], startedAt, completedAt: new Date(),
                durationMs: Date.now() - startedAt.getTime(),
            };
        }
        this.log('[E2E] ✅ TCP server reachable.\n');

        const testCases = this.buildTestCases();
        this.log(`[E2E] Running ${testCases.length} test cases...\n`);

        const results: E2ETestResult[] = [];
        let passed = 0, failed = 0, errors = 0;

        for (const tc of testCases) {
            this.log(`━━━ ${tc.testId}: ${tc.name} [${tc.category}] ━━━`);
            this.log(`    ${tc.description}`);

            const result = await this.runTest(tc);
            results.push(result);

            const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '💥';
            this.log(`  ${icon} ${result.status}: ${result.reason}`);
            if (result.dbValidation) {
                this.log(`  📦 DB: ${result.dbValidation.found
                    ? `Found in ${result.dbValidation.collection}`
                    : 'Not found'}`);
            }
            this.log('');

            if (result.status === 'PASS') passed++;
            else if (result.status === 'FAIL') failed++;
            else errors++;

            // Brief pause between tests so machine TID cache doesn't interfere
            await sleep(800);
        }

        const completedAt = new Date();
        const report: E2EReport = {
            sessionId, totalTests: testCases.length,
            passed, failed, errors, results, startedAt, completedAt,
            durationMs: completedAt.getTime() - startedAt.getTime(),
        };

        this.log('═══════════════════════════════════════════════════════════');
        this.log(`  📊 RESULTS: ${passed} passed, ${failed} failed, ${errors} errors (${testCases.length} total)`);
        this.log(`  ⏱  Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
        this.log('═══════════════════════════════════════════════════════════');

        return report;
    }
}