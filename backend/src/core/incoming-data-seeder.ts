import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface SeedResult {
    pushed: string[];
    failed: string[];
    validAwb: string | null;
}

// ── Known destination_column names that represent the barcode/AWB ─────────────
// Checked in priority order — first match wins.
// Add new client barcode field names here — no other code changes needed.
const BARCODE_DESTINATION_COLUMNS = [
    'awb',            // Meesho
    'hu_id',          // DHL
    'item_id',        // Flipkart
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

        // 4. Select the correct push config (clientName passed for Strategy B fallback)
        const pushConfig = await this.getPushConfig(machineDoc, clientName, onLog);
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

        // Start incoming-service on VM via SSH before pushing data
        await this.startIncomingService(port, onLog);

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

    // ════════════════════════════════════════════════════════════════════════════
    //  Start incoming-service on VM via SSH + PM2
    //  (port is passed in so waitForPort uses the actual resolved port)
    // ════════════════════════════════════════════════════════════════════════════

    private async startIncomingService(port: number, onLog: (msg: string) => void): Promise<void> {
        const ssh = new NodeSSH();
        try {
            onLog('[SPAWNER] Starting incoming-service on VM...');

            await ssh.connect({
                host: this.vmIp,
                username: 'manthan',
                password: '1234',
            });

            const result = await ssh.execCommand(
                'sudo pm2 start /tmp/automyrix-ecosystem.config.js --only automyrix-incoming-service',
                { execOptions: { pty: true } }
            );

            if (result.stdout) onLog(`[PM2] ${result.stdout.trim()}`);
            if (result.stderr) onLog(`[PM2] ${result.stderr.trim()}`);

            // Wait using the actual resolved port from machine_services_config
            await this.waitForPort(this.vmIp, port, 60000, onLog);

            onLog(`[SPAWNER] incoming-service ready on port ${port} ✅`);
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
    //  Strategy A (primary): machine.incoming_data_config[] → ids → incoming_config
    //    Used by: Meesho, DHL, Flipkart ANJ_SORTER_1
    //
    //  Strategy B (fallback): when machine has no incoming_data_config,
    //    scan incoming_service.incoming_config directly by client name.
    //    Used by: machines where config refs are missing from machine doc.
    //
    //  Within results, selection priority:
    //    1. destination_collection === 'incoming_service.incoming_data'
    //       AND client name matches
    //    2. destination_collection === 'incoming_service.incoming_data'
    //    3. route.endpoint contains '/incoming'
    //    4. configs[0]
    // ════════════════════════════════════════════════════════════════════════════

    private async getPushConfig(
        machineDoc: any,
        clientName: string,
        onLog: (msg: string) => void
    ): Promise<any | null> {
        const configRefs: Array<{ id: string }> = machineDoc.incoming_data_config || [];
        const client = new MongoClient(this.mongoUri);

        try {
            await client.connect();
            const collection = client.db('incoming_service').collection('incoming_config');
            let configs: any[] = [];

            if (configRefs.length > 0) {
                // ── Strategy A: lookup by ids embedded in machine doc ──────────────
                const ids = configRefs.map(c => c.id);
                onLog(`[SEEDER] Strategy A — looking up ${ids.length} config id(s): ${ids.join(', ')}`);
                configs = await collection
                    .find({ _id: { $in: ids as any[] }, type: 'push' })
                    .toArray();
            }

            if (configs.length === 0) {
                // ── Strategy B: scan by client name ───────────────────────────────
                onLog(`[SEEDER] Strategy B — scanning configs for client: "${clientName}"`);
                configs = await collection
                    .find({
                        type: 'push',
                        destination_collection: 'incoming_service.incoming_data',
                        client: { $regex: new RegExp(`^${clientName}$`, 'i') },
                    })
                    .toArray();

                if (configs.length === 0) {
                    // Broaden: any push config targeting incoming_data
                    onLog(`[SEEDER] Strategy B broadened — any push config targeting incoming_data`);
                    configs = await collection
                        .find({ type: 'push', destination_collection: 'incoming_service.incoming_data' })
                        .toArray();
                }
            }

            if (configs.length === 0) {
                onLog(`[SEEDER] No push-type config found for client: ${clientName}`);
                return null;
            }

            onLog(`[SEEDER] Found ${configs.length} push config(s):`);
            for (const c of configs) {
                onLog(`  • "${c.name}" | client: ${c.client} | dest: ${c.destination_collection} | endpoint: ${c.route?.endpoint}`);
            }

            const clientRegex = new RegExp(`^${clientName}$`, 'i');
            const chosen =
                // Priority 1: correct collection + correct client
                configs.find(c =>
                    c.destination_collection === 'incoming_service.incoming_data' &&
                    clientRegex.test(c.client || '')
                ) ||
                // Priority 2: correct collection, any client
                configs.find(c => c.destination_collection === 'incoming_service.incoming_data') ||
                // Priority 3: endpoint hint
                configs.find(c => (c.route?.endpoint as string | undefined)?.includes('/incoming')) ||
                configs[0];

            onLog(`[SEEDER] Selected: "${chosen.name}" (client: ${chosen.client})`);
            return chosen;

        } finally {
            await client.close();
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Step 5 — Load test data
    // ════════════════════════════════════════════════════════════════════════════

    private loadTestData(clientName: string, onLog: (msg: string) => void): any[] {
        const filePath = path.join(this.workspacePath, 'backend', 'test-data', 'incoming-test.json');

        if (!fs.existsSync(filePath)) {
            throw new Error(`[SEEDER] Test data file not found at: ${filePath}`);
        }

        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // "Meesho" → "meesho_incoming", "Flipkart" → "flipkart_incoming"
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
        const rawEndpoint: string = config.route?.endpoint || '/api/v1/incoming/data';
        const method: string = (config.route?.method || 'POST').toLowerCase();
        const targetPayload: string = config.target_payload ?? '';
        const mappings: any[] = config.mappings || [];

        // Detect whether the payload wraps records as an array
        // Meesho:   { "data": record }           → wrapAsArray = false
        // Flipkart: { "sortation_data_list": [record] } → wrapAsArray = true
        const wrapAsArray = this.isArrayPayload(config);
        onLog(`[SEEDER] Payload mode: ${targetPayload ? `"${targetPayload}" (${wrapAsArray ? 'array' : 'object'})` : 'root level'}`);

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
                // Substitute path params for this record before building URL
                // e.g. /api/v2/facility/:facilityId/installation/:installationId/...
                const resolvedEndpoint = this.substitutePathParams(rawEndpoint, record, mappings, onLog);
                const url = `http://${this.vmIp}:${port}${resolvedEndpoint}`;

                const builtRecord = this.buildRecord(record, mappings);
                const payload = this.wrapPayload(builtRecord, targetPayload, wrapAsArray);

                onLog(`[SEEDER] → Pushing barcode: ${barcodeValue} to ${url}`);
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
    //  Array payload detector
    //
    //  Returns true when target_payload should wrap the record in an array.
    //  Detection: response_mapping[200].mappings[0].source_column === targetPayload
    //             AND value_type === 'array'
    //
    //  Meesho:   target_payload="data"                → object → false
    //  Flipkart: target_payload="sortation_data_list" → array  → true
    // ════════════════════════════════════════════════════════════════════════════

    private isArrayPayload(config: any): boolean {
        const targetPayload = config.target_payload || '';
        if (!targetPayload) return false;

        const successMapping = config.response_mapping?.find(
            (rm: any) => rm.http_status_code === 200
        );
        const firstMapping = successMapping?.mappings?.[0];
        return (
            firstMapping?.source_column === targetPayload &&
            firstMapping?.value_type === 'array'
        );
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Path param substitution
    //
    //  Replaces :paramName tokens in the endpoint URL using values from the record.
    //
    //  Example:
    //    endpoint = "/api/v2/facility/:facilityId/installation/:installationId/..."
    //    mapping  = { source_column: "params.params.facilityId", destination_column: "facility_id" }
    //    record   = { params: { params: { facilityId: "FAC001", installationId: "INST001" } } }
    //    result   = "/api/v2/facility/FAC001/installation/INST001/..."
    // ════════════════════════════════════════════════════════════════════════════

    private substitutePathParams(
        endpoint: string,
        record: any,
        mappings: any[],
        onLog: (msg: string) => void
    ): string {
        const paramRegex = /:([a-zA-Z]+)/g;
        const params = [...endpoint.matchAll(paramRegex)].map(m => m[1]);
        if (params.length === 0) return endpoint;

        let resolved = endpoint;

        for (const paramName of params) {
            // Convert camelCase param to snake_case for destination_column matching
            const snakeCase = paramName.replace(/([A-Z])/g, '_$1').toLowerCase();

            // Find the mapping whose destination_column matches this param name
            const mapping = mappings.find(m =>
                m.source_column &&
                (m.destination_column === paramName || m.destination_column === snakeCase)
            );

            if (mapping) {
                const value = this.resolvePath(record, mapping.source_column);
                if (value !== undefined && value !== null) {
                    resolved = resolved.replace(`:${paramName}`, String(value));
                    onLog(`[SEEDER] Path param :${paramName} → "${value}" (from ${mapping.source_column})`);
                } else {
                    onLog(`[SEEDER] ⚠️ Path param :${paramName} — "${mapping.source_column}" resolved to null in record`);
                }
            } else {
                // Last resort: try to resolve directly from record
                const directValue =
                    this.resolvePath(record, paramName) ??
                    this.resolvePath(record, snakeCase);
                if (directValue !== undefined && directValue !== null) {
                    resolved = resolved.replace(`:${paramName}`, String(directValue));
                    onLog(`[SEEDER] Path param :${paramName} → "${directValue}" (direct record field)`);
                } else {
                    onLog(`[SEEDER] ⚠️ No mapping for path param :${paramName} — leaving as-is`);
                }
            }
        }

        return resolved;
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Barcode field detector
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
    //  Record builder — RECORD-FIRST STRATEGY
    //
    //  1. Deep-clone the record (Direct/Nested fields already present)
    //  2. Overlay GUID / Static / Now generated values at top level
    // ════════════════════════════════════════════════════════════════════════════

    private buildRecord(record: any, mappings: any[]): Record<string, any> {
        const built: Record<string, any> = JSON.parse(JSON.stringify(record));

        for (const mapping of mappings) {
            const format: string = mapping.format || 'Direct';
            switch (format) {
                case 'GUID':
                    built[mapping.destination_column] = uuidv4();
                    break;
                case 'Static':
                    built[mapping.destination_column] = mapping.value;
                    break;
                case 'Now':
                    built[mapping.destination_column] = new Date().toISOString();
                    break;
                // Direct / Nested: already in record — skip
            }
        }

        return built;
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  Payload wrapper
    //
    //  targetPayload=""          → built directly               (DHL)
    //  targetPayload="data"      + array=false → { "data": built }         (Meesho)
    //  targetPayload="sortation_data_list" + array=true  → { "sortation_data_list": [built] } (Flipkart)
    // ════════════════════════════════════════════════════════════════════════════

    private wrapPayload(
        built: Record<string, any>,
        targetPayload: string,
        wrapAsArray: boolean
    ): Record<string, any> {
        if (!targetPayload) return built;
        return { [targetPayload]: wrapAsArray ? [built] : built };
    }
}