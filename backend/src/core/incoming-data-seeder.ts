import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
const ECOSYSTEM_PATH = '/tmp/automyrix-ecosystem.config.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'dns';

const execAsync = promisify(exec);

export interface SeedResult {
    pushed: string[];        // barcode values successfully POSTed
    failed: string[];        // barcode values (or record indices) that failed
    validAwb: string | null; // first successfully pushed barcode — used for SUCC + DUPR
}

// ── Known destination_column names that represent the barcode/AWB ─────────────
// Scanned in order — first match wins.
const BARCODE_DESTINATION_COLUMNS = [
    'awb',
    'hu_id',
    'barcode',
    'awb_number',
    'tracking_no',
    'shipment_no',
    'parcel_id',
    'consignment_id',
];

export class IncomingDataSeeder {

    constructor(
        private mongoUri: string,
        private vmIp: string,
        private workspacePath: string
    ) { }

    // ════════════════════════════════════════════════════════════════════════════
    //  Main entry point
    // ════════════════════════════════════════════════════════════════════════════

    async seed(
        clientName: string,
        machineId: string,
        onLog: (msg: string) => void
    ): Promise<SeedResult> {

        // 1. Clear incoming_data on VM MongoDB
        await this.clearIncomingData(onLog);

        // 2. Fetch full machine doc
        const machineDoc = await this.getMachineDoc(machineId);
        if (!machineDoc) throw new Error(`[SEEDER] Machine doc not found for id: ${machineId}`);

        // 3. Get incoming-service port from machine_services_config
        const serviceConfig = machineDoc.machine_services_config?.['incoming-service'];
        if (!serviceConfig?.port) {
            throw new Error(
                `[SEEDER] incoming-service port not found in machine_services_config for machine: ${machineId}`
            );
        }
        const port: number = serviceConfig.port;
        onLog(`[SEEDER] incoming-service port resolved: ${port}`);

        // 4. Select the correct push config
        const pushConfig = await this.getPushConfig(machineDoc, onLog);
        if (!pushConfig) {
            throw new Error(`[SEEDER] No push-type incoming_config found for machine: ${machineId}`);
        }
        onLog(`[SEEDER] Push config resolved: "${pushConfig.name}" → ${pushConfig.route?.endpoint}`);

        // 5. Load test data from control machine disk
        const records = this.loadTestData(clientName, onLog);
        if (records.length === 0) {
            throw new Error(`[SEEDER] No records found for client "${clientName}" in incoming-test.json`);
        }
        onLog(`[SEEDER] Loaded ${records.length} records for client: ${clientName}`);

        await this.startIncomingService(onLog);

        // 6. POST each record to VM incoming-service
        return await this.pushAll(records, pushConfig, port, onLog);
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 1 — Clear incoming_data
    // ════════════════════════════════════════════════════════════════════════════

    private async clearIncomingData(onLog: (msg: string) => void): Promise<void> {
        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            const result = await client
                .db('incoming_service')
                .collection('incoming_data')
                .deleteMany({});
            onLog(`[SEEDER] Cleared ${result.deletedCount} documents from incoming_service.incoming_data`);
        } finally {
            await client.close();
        }
    }


    //Stsrt incoming service for seeding Data
    private async startIncomingService(onLog: (msg: string) => void): Promise<void> {
        const ssh = new NodeSSH();
        try {
            onLog('[SPAWNER] Starting Incoming-service');

            await ssh.connect({
                host: this.vmIp,
                username: 'manthan',
                password: '1234',
            });

            const result = await ssh.execCommand(
                'sudo pm2 start /tmp/automyrix-ecosystem.config.js --only automyrix-incoming-service',
                { execOptions: { pty: true } }  // pty needed for sudo
            );

            if (result.stdout) onLog(`[PM2] ${result.stdout.trim()}`);
            if (result.stderr) onLog(`[PM2] ${result.stderr.trim()}`);

            await this.waitForPort(this.vmIp, 7000, 60000, onLog);

            onLog('Incoming-service Started');
        } finally {
            ssh.dispose();
        }
    }

    private async waitForPort(
        host: string,
        port: number,
        timeoutMs: number,
        onLog: (msg: string) => void
    ): Promise<void> {
        const net = await import('net');
        const interval = 2000;
        const deadline = Date.now() + timeoutMs;

        onLog(`[SPAWNER] Waiting for ${host}:${port} to be ready...`);

        while (Date.now() < deadline) {
            const reachable = await new Promise<boolean>(resolve => {
                const sock = new net.Socket();
                sock.setTimeout(1500);
                sock.once('connect', () => { sock.destroy(); resolve(true); });
                sock.once('error', () => { sock.destroy(); resolve(false); });
                sock.once('timeout', () => { sock.destroy(); resolve(false); });
                sock.connect(port, host);
            });

            if (reachable) {
                onLog(`[SPAWNER] Port ${port} is ready ✅`);
                return;
            }

            onLog(`[SPAWNER] Port ${port} not ready yet, retrying in ${interval / 1000}s...`);
            await new Promise(r => setTimeout(r, interval));
        }

        throw new Error(`[SPAWNER] Timed out waiting for ${host}:${port} after ${timeoutMs / 1000}s`);
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 2 — Fetch machine document
    // ════════════════════════════════════════════════════════════════════════════

    private async getMachineDoc(machineId: string): Promise<any | null> {
        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            return await client
                .db('machine_configurations')
                .collection('machines')
                .findOne({ _id: machineId as any });
        } finally {
            await client.close();
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 4 — Select the correct push config
    //
    //  Selection priority (first match wins):
    //    1. destination_collection === 'incoming_service.incoming_data'
    //    2. route.endpoint contains '/incoming/data'
    //    3. configs[0]  ← last resort
    //
    //  Logs all candidates so selection is always visible.
    // ════════════════════════════════════════════════════════════════════════════

    private async getPushConfig(machineDoc: any, onLog: (msg: string) => void): Promise<any | null> {
        const configRefs: Array<{ id: string }> = machineDoc.incoming_data_config || [];
        if (configRefs.length === 0) {
            onLog(`[SEEDER] No incoming_data_config entries found on machine doc`);
            return null;
        }

        const ids = configRefs.map(c => c.id);
        onLog(`[SEEDER] Looking up ${ids.length} incoming config(s): ${ids.join(', ')}`);

        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            const configs = await client
                .db('incoming_service')
                .collection('incoming_config')
                .find({ _id: { $in: ids as any[] }, type: 'push' })
                .toArray();

            if (configs.length === 0) {
                onLog(`[SEEDER] No push-type config found`);
                return null;
            }

            onLog(`[SEEDER] Found ${configs.length} push config(s):`);
            for (const c of configs) {
                onLog(`  • "${c.name}" | dest_collection: ${c.destination_collection} | endpoint: ${c.route?.endpoint}`);
            }

            const chosen =
                configs.find(c => c.destination_collection === 'incoming_service.incoming_data') ||
                configs.find(c => (c.route?.endpoint as string | undefined)?.includes('/incoming/data')) ||
                configs[0];

            onLog(`[SEEDER] Selected: "${chosen.name}"`);
            return chosen;

        } finally {
            await client.close();
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 5 — Load test data
    // ════════════════════════════════════════════════════════════════════════════

    private loadTestData(clientName: string, onLog: (msg: string) => void): any[] {
        // workspacePath = Automation_testing root
        // File: Automation_testing/backend/test-data/incoming-test.json
        const filePath = path.join(this.workspacePath, 'backend', 'test-data', 'incoming-test.json');

        if (!fs.existsSync(filePath)) {
            throw new Error(`[SEEDER] Test data file not found at: ${filePath}`);
        }

        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // "Meesho" → "meesho_incoming",  "DHL" → "dhl_incoming"
        const key = `${clientName.toLowerCase()}_incoming`;
        const records = raw[key];



        if (!records || !Array.isArray(records) || records.length === 0) {
            onLog(`[SEEDER] No records found for key "${key}" in incoming-test.json`);
            return [];
        }

        return records;
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 6 — POST all records
    // ════════════════════════════════════════════════════════════════════════════

    private async pushAll(
        records: any[],
        config: any,
        port: number,
        onLog: (msg: string) => void
    ): Promise<SeedResult> {
        const endpoint: string = config.route?.endpoint || '/api/v1/incoming/data';
        const method: string = (config.route?.method || 'POST').toLowerCase();
        const targetPayload: string = config.target_payload ?? '';
        const url = `http://${this.vmIp}:${port}${endpoint}`;
        const mappings: any[] = config.mappings || [];

        onLog(`[SEEDER] Target URL: ${url}`);
        onLog(`[SEEDER] Payload wrapper: ${targetPayload ? `"${targetPayload}"` : 'none (root level)'}`);

        // Find which source path resolves to the barcode for logging/tracking
        const barcodeSourcePath = this.findBarcodeSourcePath(mappings);
        onLog(`[SEEDER] Barcode source path: "${barcodeSourcePath ?? 'not detected'}"`);

        const pushed: string[] = [];
        const failed: string[] = [];

        for (let i = 0; i < records.length; i++) {
            const record = records[i];

            const barcodeValue: string = barcodeSourcePath
                ? String(this.resolvePath(record, barcodeSourcePath) ?? `record[${i}]`)
                : `record[${i}]`;

            try {
                const payload = this.buildPayload(record, mappings, targetPayload);

                onLog(`[SEEDER] → Pushing barcode: ${barcodeValue}`);
                logger.info(`[SEEDER] Payload: ${JSON.stringify(payload)}`, 'SEEDER');

                const response = await axios({
                    method,
                    url,
                    data: payload,
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000,
                });

                onLog(`[SEEDER] ✅ ${barcodeValue} → HTTP ${response.status}`);
                pushed.push(barcodeValue);

            } catch (err: any) {
                const detail = err.response
                    ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
                    : err.message;
                onLog(`[SEEDER] ❌ ${barcodeValue} failed: ${detail}`);
                failed.push(barcodeValue);
            }
        }

        onLog(`[SEEDER] Seeding complete — ${pushed.length} pushed, ${failed.length} failed`);
        return { pushed, failed, validAwb: pushed.length > 0 ? pushed[0] : null };
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Barcode field detector
    //
    //  Scans mappings for the first one whose destination_column is a known
    //  barcode name. Returns the source_column path so we can deep-resolve the
    //  barcode value from any test-data record structure.
    //
    //  Meesho: dest="awb"   → source="awb"
    //  DHL:    dest="hu_id" → source="packConfirmResponse.labels.0.huIdentifier"
    // ════════════════════════════════════════════════════════════════════════════

    private findBarcodeSourcePath(mappings: any[]): string | null {
        for (const destCol of BARCODE_DESTINATION_COLUMNS) {
            const mapping = mappings.find(
                m =>
                    m.destination_column === destCol &&
                    m.source_column &&
                    m.format !== 'Nested' &&
                    m.format !== 'GUID'
            );
            if (mapping) {
                logger.info(
                    `[SEEDER] Barcode field: dest="${destCol}" source="${mapping.source_column}"`,
                    'SEEDER'
                );
                return mapping.source_column;
            }
        }
        return null;
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Deep path resolver
    //
    //  resolvePath(obj, "awb")                                   → obj.awb
    //  resolvePath(obj, "packConfirmResponse.transport.carrier") → obj.packConfirmResponse.transport.carrier
    //  resolvePath(obj, "packConfirmResponse.labels.0.huIdentifier") → obj.packConfirmResponse.labels[0].huIdentifier
    // ════════════════════════════════════════════════════════════════════════════

    private resolvePath(obj: any, dotPath: string): any {
        return dotPath.split('.').reduce((cur, seg) => {
            if (cur === null || cur === undefined) return undefined;
            const idx = parseInt(seg, 10);
            if (!isNaN(idx) && Array.isArray(cur)) return cur[idx];
            return cur[seg];
        }, obj);
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Payload builder — RECORD-FIRST STRATEGY
    //
    //  WHY record-first:
    //
    //  The incoming-service mapping engine resolves source_column paths FROM the
    //  request body. For Meesho, source_columns are flat ("awb", "next_node") so
    //  the record IS the payload. For DHL, source_columns are nested paths
    //  ("packConfirmResponse.transport.carrier") — the service resolves these from
    //  the nested JSON, not from flat dot-notation keys.
    //
    //  So the correct approach for ALL clients is:
    //    1. Start with a deep copy of the record (all Direct + Nested fields
    //       are already present in the correct shape)
    //    2. Overlay GUID / Static / Now values using destination_column as key
    //       (these have no source — they're generated server-side or at push time)
    //    3. Wrap with target_payload if non-empty
    //
    //  Result by client:
    //
    //  Meesho  → { "data": { "awb":"VL...", "next_node":"FHE", ...,
    //                         "_id":"<uuid>", "status":"queued", "upload_time":"..." } }
    //
    //  DHL     → { "uniqueTransactionId":"...", "packConfirmResponse":{ ... },
    //               "_id":"<uuid>", "upload_time":"..." }
    //            (no wrapper — target_payload is empty)
    // ════════════════════════════════════════════════════════════════════════════

    private buildPayload(
        record: any,
        mappings: any[],
        targetPayload: string
    ): Record<string, any> {

        // Deep-clone the record so we never mutate the original
        const built: Record<string, any> = JSON.parse(JSON.stringify(record));

        // Overlay only the generated fields (GUID / Static / Now)
        // Direct and Nested fields are already present in `built` from the record
        for (const mapping of mappings) {
            const format: string = mapping.format || 'Direct';

            switch (format) {

                case 'GUID':
                    // destination_column e.g. "_id" — add at top level
                    built[mapping.destination_column] = uuidv4();
                    break;

                case 'Static':
                    // destination_column e.g. "status", value e.g. "queued"
                    built[mapping.destination_column] = mapping.value;
                    break;

                case 'Now':
                    // destination_column e.g. "upload_time"
                    built[mapping.destination_column] = new Date().toISOString();
                    break;

                // Direct / Nested: already present from the record — skip
                default:
                    break;
            }
        }

        // Wrap only when target_payload is a non-empty string
        // Meesho: target_payload = "data"  → { "data": built }
        // DHL:    target_payload = ""      → built directly
        return targetPayload ? { [targetPayload]: built } : built;
    }
}