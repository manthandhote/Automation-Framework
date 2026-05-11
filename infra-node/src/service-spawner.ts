import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { logger } from './logger';

const execAsync = util.promisify(exec);

// ─── Static service definitions ───────────────────────────────────────────────
// Port is NOT hardcoded here — resolved at runtime from machine_services_config.
// configKey = the key name inside machine_services_config in the machine document.
// Note: dataposting-service folder = 'dataposting-service' but its config key
//       in the machine document is 'datauploader-service'.
const SERVICES = [
    { name: 'app-device-interface', script: 'src/app.ts', configKey: 'app-device-interface' },
    { name: 'incoming-service', script: 'src/Server.ts', configKey: 'incoming-service' },
    { name: 'validation-engine', script: 'src/app.ts', configKey: 'validation-engine' },
    { name: 'mapper-service', script: 'src/Server.ts', configKey: 'mapper-service' },
    { name: 'dataposting-service', script: 'src/Server.ts', configKey: 'datauploader-service' },
    { name: 'backend-for-frontend', script: 'src/server.ts', configKey: 'backend-for-frontend' },
];

const PM2_PREFIX = 'automyrix';
const ECOSYSTEM_PATH = '/tmp/automyrix-ecosystem.config.js';

export interface SpawnConfig {
    bePath: string;
    sessionId: string;
    mongoUri: string;
    dbName: string;
    machineId: string;
    machineKey: string;
    onLog: (msg: string) => void;
}

interface ServiceEndpoint {
    ip: string;
    port: number;
}

export class ServiceSpawner {

    // ── Public API ─────────────────────────────────────────────────────────────

    static async spawnAll(config: SpawnConfig): Promise<{ success: boolean; error?: string }> {
        const { bePath, sessionId, mongoUri, dbName, machineId, machineKey, onLog } = config;

        // 1. Stop any previously running automyrix PM2 processes
        await ServiceSpawner.stopAll(sessionId, onLog);

        const appsPath = path.join(bePath, 'apps');
        if (!fs.existsSync(appsPath)) {
            return { success: false, error: `apps/ folder not found at ${bePath}` };
        }

        // 2. Fetch machine_services_config from MongoDB
        onLog(`[SPAWNER] Fetching machine_services_config for machineId: ${machineId}...`);
        let machineServicesConfig: Record<string, ServiceEndpoint> = {};
        try {
            machineServicesConfig = await ServiceSpawner.fetchMachineServicesConfig(mongoUri, machineId);
            const portSummary = Object.entries(machineServicesConfig)
                .map(([k, v]) => `${k}:${v.port}`)
                .join(', ');
            onLog(`[SPAWNER] Ports from machine_services_config → ${portSummary}`);
        } catch (e: any) {
            onLog(`[SPAWNER] ⚠️  Could not load machine_services_config: ${e.message} — services will be skipped`);
        }

        // 3. Build shared libs
        try {
            await ServiceSpawner.buildSharedLibs(bePath, onLog);
        } catch (e: any) {
            return { success: false, error: `Shared lib build failed: ${e.message}` };
        }

        // 4. Build .env + PM2 app entry for each service
        const ecosystemApps: object[] = [];

        for (const svc of SERVICES) {
            const svcPath = path.join(appsPath, svc.name);
            if (!fs.existsSync(svcPath)) {
                onLog(`[SPAWNER] ⚠️  ${svc.name} not found at ${svcPath} — skipping`);
                continue;
            }

            // Resolve port from machine_services_config
            const endpoint = machineServicesConfig[svc.configKey];
            if (!endpoint) {
                onLog(`[SPAWNER] ⚠️  No entry for '${svc.configKey}' in machine_services_config — skipping ${svc.name}`);
                continue;
            }
            const port = endpoint.port;

            // Install node_modules if missing
            if (!fs.existsSync(path.join(svcPath, 'node_modules'))) {
                onLog(`[SPAWNER] Installing deps for ${svc.name}...`);
                try {
                    await execAsync('npm install --ignore-scripts', { cwd: svcPath });
                } catch (e: any) {
                    onLog(`[SPAWNER] ⚠️  npm install failed for ${svc.name}: ${e.message}`);
                }
            }

            // Build env vars
            const envVars: Record<string, string> = {
                PORT: port.toString(),
                MONGO_URI: mongoUri,
                MONGODB_URI: mongoUri,
                NODE_ENV: 'development',
                SESSION_ID: sessionId,
                IS_SIMULATION: 'true',
                MONGO_DB: svc.name === 'app-device-interface' ? 'machine_configurations' : dbName,
                SORTING_DB: dbName,
                INCOMING_DB: dbName,
                MACHINE_CONFIG_DB: 'machine_configurations',
                IDENTITY_DB: dbName,
                CALIBRATION_DB: dbName,
                NOTIFICATION_DB: dbName,
                CYCLIC_DB: dbName,
                UPLOADER_DB: dbName,
            };

            if (svc.name === 'app-device-interface') {
                envVars['MACHINE_ID'] = machineId;
                envVars['MACHINE_KEY'] = machineKey;
            }

            // Write .env file
            fs.writeFileSync(
                path.join(svcPath, '.env'),
                Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')
            );

            onLog(`[SPAWNER] ➡ ${svc.name} → port ${port}`);

            ecosystemApps.push({
                name: `${PM2_PREFIX}-${svc.name}`,
                script: svc.script,
                interpreter: 'node',
                interpreterArgs: ['--import', 'tsx'],
                cwd: svcPath,
                watch: false,
                exec_mode: 'fork',
                instances: 1,
                autorestart: false,
                env: envVars,
            });
        }

        if (ecosystemApps.length === 0) {
            return { success: false, error: 'No services could be resolved from machine_services_config.' };
        }

        // 5. Write ecosystem file
        const ecosystemContent =
            `module.exports = { apps: ${JSON.stringify(ecosystemApps, null, 2)} };`;
        fs.writeFileSync(ECOSYSTEM_PATH, ecosystemContent);
        onLog(`[SPAWNER] Ecosystem config written → ${ECOSYSTEM_PATH} (${ecosystemApps.length} apps)`);

        // 6. Start via PM2
        try {
            onLog(`[SPAWNER] Starting ${ecosystemApps.length} services via PM2...`);
            const { stdout, stderr } = await execAsync(
                `sudo pm2 start ${ECOSYSTEM_PATH}`,
                { timeout: 120000 }
            );
            if (stdout) onLog(`[PM2] ${stdout.trim()}`);
            if (stderr) onLog(`[PM2] ${stderr.trim()}`);
        } catch (e: any) {
            return { success: false, error: `PM2 start failed: ${e.message?.split('\n')[0]}` };
        }

        onLog(`[SPAWNER] ✅ All services started via PM2`);

        // 7. Stream PM2 logs to socket
        ServiceSpawner.streamPm2Logs(onLog);

        // 8. Wait for app-device-interface HTTP port to confirm readiness
        const appDevicePort = machineServicesConfig['app-device-interface']?.port || 5500;
        await ServiceSpawner.waitForPort(appDevicePort, 60000, onLog);

        return { success: true };
    }

    // ── Fetch machine_services_config from MongoDB ────────────────────────────

    private static async fetchMachineServicesConfig(
        mongoUri: string,
        machineId: string
    ): Promise<Record<string, ServiceEndpoint>> {
        const client = new MongoClient(mongoUri);
        try {
            await client.connect();
            const doc = await client
                .db('machine_configurations')
                .collection('machines')
                .findOne({ _id: machineId as any });

            if (!doc) throw new Error(`Machine document not found for ID: ${machineId}`);
            if (!doc.machine_services_config) throw new Error(`machine_services_config missing in machine document`);

            return doc.machine_services_config as Record<string, ServiceEndpoint>;
        } finally {
            await client.close();
        }
    }

    // ── Stop all automyrix PM2 processes ──────────────────────────────────────

    static async stopAll(sessionId: string, onLog: (msg: string) => void) {
        onLog(`[SPAWNER] Stopping previous PM2 processes (prefix: ${PM2_PREFIX})...`);
        try {
            const { stdout } = await execAsync(`sudo pm2 jlist`, { timeout: 10000 });
            const list: any[] = JSON.parse(stdout || '[]');
            const ours = list
                .filter(p => p.name?.startsWith(PM2_PREFIX))
                .map(p => p.name);

            if (ours.length > 0) {
                await execAsync(`sudo pm2 delete ${ours.join(' ')}`, { timeout: 30000 });
                onLog(`[SPAWNER] Deleted PM2 processes: ${ours.join(', ')}`);
            } else {
                onLog(`[SPAWNER] No existing PM2 processes to stop.`);
            }
        } catch (_) {
            onLog(`[SPAWNER] No PM2 processes found (fresh start).`);
        }
    }

    // ── Stream PM2 logs → onLog ───────────────────────────────────────────────

    private static streamPm2Logs(onLog: (msg: string) => void) {
        try {
            const { spawn: spawnChild } = require('child_process');
            const tail = spawnChild('sudo', ['pm2', 'logs', '--raw', '--lines', '0'], { shell: true });
            tail.stdout?.on('data', (d: Buffer) => {
                d.toString().trim().split('\n').forEach((l: string) => {
                    if (l.trim()) onLog(`[PM2-LOG] ${l.trim()}`);
                });
            });
            tail.stderr?.on('data', (d: Buffer) => {
                d.toString().trim().split('\n').forEach((l: string) => {
                    if (l.trim()) onLog(`[PM2-LOG] ${l.trim()}`);
                });
            });
        } catch (e: any) {
            onLog(`[SPAWNER] Could not stream PM2 logs: ${e.message}`);
        }
    }

    // ── Build shared libs ─────────────────────────────────────────────────────

    private static async buildSharedLibs(bePath: string, onLog: (msg: string) => void) {
        const libs = ['shared-logger', 'shared-db', 'shared-server'];
        const libsRoot = path.join(bePath, 'libs');

        if (!fs.existsSync(libsRoot)) {
            onLog(`[SPAWNER] No libs folder — skipping shared lib build`);
            return;
        }

        for (const lib of libs) {
            const libPath = path.join(libsRoot, lib);
            if (!fs.existsSync(libPath)) continue;

            if (lib === 'shared-logger') {
                const pkgPath = path.join(libPath, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
                        onLog(`[SPAWNER] Patching ${lib} dependencies...`);
                        pkg.dependencies = { pino: '^10.3.1', 'pino-pretty': '^13.0.0' };
                        pkg.devDependencies = { '@types/node': '^20.0.0' };
                        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                    }
                }
            }

            onLog(`[SPAWNER] Building ${lib}...`);
            await execAsync('npm install --ignore-scripts', { cwd: libPath });
            await execAsync('npm run build', { cwd: libPath });

            if (!fs.existsSync(path.join(libPath, 'dist'))) {
                throw new Error(`${lib} build produced no dist/`);
            }
            onLog(`[SPAWNER] ✅ ${lib} built`);
        }

        onLog(`[SPAWNER] Installing root workspace deps...`);
        await execAsync('npm install --ignore-scripts', { cwd: bePath });
    }

    // ── Wait for TCP port ─────────────────────────────────────────────────────

    private static async waitForPort(
        port: number,
        timeoutMs: number,
        onLog: (msg: string) => void
    ): Promise<void> {
        const start = Date.now();
        onLog(`[SPAWNER] Waiting for TCP port ${port} to open...`);
        while (Date.now() - start < timeoutMs) {
            try {
                await execAsync(`nc -z 127.0.0.1 ${port}`);
                onLog(`[SPAWNER] ✅ Port ${port} is open — services ready`);
                return;
            } catch {
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        onLog(`[SPAWNER] ⚠️  Port ${port} not open after ${timeoutMs}ms — proceeding anyway`);
    }
}