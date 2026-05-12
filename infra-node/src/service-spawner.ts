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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse an existing .env file into a key→value map.
 * Lines starting with # (comments) and blank lines are preserved as-is
 * in the raw text but are skipped for the map.
 */
function parseEnvFile(envPath: string): Record<string, string> {
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const result: Record<string, string> = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.substring(0, eqIdx).trim();
        const raw = line.substring(eqIdx + 1).trim();
        // Strip surrounding single or double quotes so "machine_configurations"
        // doesn't reach MongoDB with the quote characters included.
        const val = raw.replace(/^(['"])(.*)\1$/, '$2');
        result[key] = val;
    }
    return result;
}

/**
 * Patch specific keys into an existing .env file.
 * - Existing keys are updated in-place (preserving order and comments).
 * - Keys not already present are appended at the end.
 * - All other lines (comments, blanks, other keys) are left untouched.
 */
function patchEnvFile(envPath: string, patches: Record<string, string>): void {
    const remaining = { ...patches };

    let lines: string[] = fs.existsSync(envPath)
        ? fs.readFileSync(envPath, 'utf8').split('\n')
        : [];

    // Update existing keys in-place
    lines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) return line;
        const key = line.substring(0, eqIdx).trim();
        if (key in remaining) {
            const newLine = `${key}=${remaining[key]}`;
            delete remaining[key];
            return newLine;
        }
        return line;
    });

    // Append any keys that weren't already in the file
    for (const [key, val] of Object.entries(remaining)) {
        lines.push(`${key}=${val}`);
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
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

        // 4. Patch .env + build PM2 app entry for each service
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

            // ── Patch .env (read existing → update only what we own) ──────────
            const envFilePath = path.join(svcPath, '.env');

            // Keys we always set for every service
            const patches: Record<string, string> = {
                PORT: port.toString(),
                MONGO_URI: mongoUri,
                MONGODB_URI: mongoUri,
            };

            // app-device-interface also gets MACHINE_ID from the user's selection
            if (svc.name === 'app-device-interface') {
                patches['MACHINE_ID'] = machineId;
                // MACHINE_KEY is intentionally NOT written — kept as-is in .env
            }

            patchEnvFile(envFilePath, patches);
            onLog(`[SPAWNER] ✅ .env patched for ${svc.name} (PORT=${port}, MONGO_URI set${svc.name === 'app-device-interface' ? `, MACHINE_ID=${machineId}` : ''})`);

            // Read the final merged env to pass into PM2
            const finalEnv = parseEnvFile(envFilePath);

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
                env: finalEnv,      // ← PM2 gets the full patched .env, not a hand-rolled subset
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