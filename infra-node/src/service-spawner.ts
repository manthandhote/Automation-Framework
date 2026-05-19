import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { logger } from './logger';

const execAsync = util.promisify(exec);

// ─── Service definitions ──────────────────────────────────────────────────────
//
// PER_MACHINE_SERVICES: one instance per machine, named with machine key suffix
//   e.g. automyrix-app-device-interface-MA01, automyrix-validation-engine-MA01
//
// SHARED_SERVICES: one instance shared by all machines
//   e.g. automyrix-incoming-service, automyrix-mapper-service
//
// configKey = the key inside machine_services_config in the machine document.

const PER_MACHINE_SERVICES = [
    { name: 'app-device-interface', script: 'src/app.ts', configKey: 'app-device-interface' },
    { name: 'validation-engine', script: 'src/app.ts', configKey: 'validation-engine' },
];

const SHARED_SERVICES = [
    { name: 'incoming-service', script: 'src/Server.ts', configKey: 'incoming-service' },
    { name: 'mapper-service', script: 'src/Server.ts', configKey: 'mapper-service' },
    { name: 'dataposting-service', script: 'src/Server.ts', configKey: 'datauploader-service' },
    { name: 'backend-for-frontend', script: 'src/server.ts', configKey: 'backend-for-frontend' },
];

const PM2_PREFIX = 'automyrix';
const ECOSYSTEM_PATH = '/tmp/automyrix-ecosystem.config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PerMachineConfig {
    machineId: string;
    machineKey: string;       // e.g. "MA01"
    machineName?: string;
    tcpPort?: number;
    services: Record<string, { port: number }>;
}

export interface SpawnConfig {
    bePath: string;
    sessionId: string;
    mongoUri: string;
    dbName: string;
    // Legacy single-machine fields (still accepted for backward compat)
    machineId: string;
    machineKey: string;
    // New multi-machine fields
    machines?: PerMachineConfig[];
    sharedServices?: Record<string, { port: number }>;
    onLog: (msg: string) => void;
}

interface ServiceEndpoint {
    ip: string;
    port: number;
}

// ─── .env helpers ─────────────────────────────────────────────────────────────

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
        result[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
    return result;
}

function patchEnvFile(envPath: string, patches: Record<string, string>): void {
    const remaining = { ...patches };
    let lines: string[] = fs.existsSync(envPath)
        ? fs.readFileSync(envPath, 'utf8').split('\n')
        : [];

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

    for (const [key, val] of Object.entries(remaining)) {
        lines.push(`${key}=${val}`);
    }

    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class ServiceSpawner {

    static async spawnAll(config: SpawnConfig): Promise<{ success: boolean; error?: string }> {
        const { bePath, sessionId, mongoUri, machineId, machineKey, onLog } = config;

        await ServiceSpawner.stopAll(sessionId, onLog);

        const appsPath = path.join(bePath, 'apps');
        if (!fs.existsSync(appsPath)) {
            return { success: false, error: `apps/ folder not found at ${bePath}` };
        }

        // ── Resolve machine list ────────────────────────────────────────────────
        // Use new machines[] if provided, otherwise fall back to single machine.
        let machines: PerMachineConfig[] = config.machines || [];

        if (machines.length === 0) {
            // Legacy path: fetch from DB using single machineId
            onLog(`[SPAWNER] Fetching machine_services_config for machineId: ${machineId}...`);
            try {
                const svcConfig = await ServiceSpawner.fetchMachineServicesConfig(mongoUri, machineId);
                const portSummary = Object.entries(svcConfig).map(([k, v]) => `${k}:${v.port}`).join(', ');
                onLog(`[SPAWNER] Ports from machine_services_config → ${portSummary}`);

                machines = [{
                    machineId,
                    machineKey,
                    services: Object.fromEntries(
                        Object.entries(svcConfig).map(([k, v]) => [k, { port: v.port }])
                    )
                }];
            } catch (e: any) {
                onLog(`[SPAWNER] ⚠️  Could not load machine_services_config: ${e.message}`);
                return { success: false, error: e.message };
            }
        }

        // Shared services port resolution:
        // Use sharedServices from orchestrator if provided,
        // otherwise read from first machine's services config.
        const sharedServicePorts: Record<string, number> = {};
        if (config.sharedServices) {
            for (const [key, val] of Object.entries(config.sharedServices)) {
                sharedServicePorts[key] = val.port;
            }
        } else {
            // Fallback: read from first machine
            const firstMachine = machines[0];
            for (const svc of SHARED_SERVICES) {
                const port = firstMachine.services[svc.configKey]?.port;
                if (port) sharedServicePorts[svc.configKey] = port;
            }
        }

        onLog(`[SPAWNER] Architecture: ${machines.length} machine(s) × ${PER_MACHINE_SERVICES.length} per-machine + ${SHARED_SERVICES.length} shared`);

        // Build shared libs once
        try {
            await ServiceSpawner.buildSharedLibs(bePath, onLog);
        } catch (e: any) {
            return { success: false, error: `Shared lib build failed: ${e.message}` };
        }

        const ecosystemApps: object[] = [];

        // ── PER-MACHINE services ────────────────────────────────────────────────
        // For each machine: spawn app-device-interface-MAxx and validation-engine-MAxx
        // on that machine's dedicated port with MACHINE_ID pointing to that machine.
        for (const machine of machines) {
            for (const svc of PER_MACHINE_SERVICES) {
                const svcPath = path.join(appsPath, svc.name);
                if (!fs.existsSync(svcPath)) {
                    onLog(`[SPAWNER] ⚠️  ${svc.name} not found — skipping`);
                    continue;
                }

                const port = machine.services[svc.configKey]?.port;
                if (!port) {
                    onLog(`[SPAWNER] ⚠️  No port for ${svc.configKey} on machine ${machine.machineKey} — skipping`);
                    continue;
                }

                // Install deps if missing (only once — node_modules shared across instances)
                if (!fs.existsSync(path.join(svcPath, 'node_modules'))) {
                    onLog(`[SPAWNER] Installing deps for ${svc.name}...`);
                    try {
                        await execAsync('npm install --ignore-scripts', { cwd: svcPath });
                    } catch (e: any) {
                        onLog(`[SPAWNER] ⚠️  npm install failed for ${svc.name}: ${e.message}`);
                    }
                }

                // Each machine instance gets its own .env copy so ports don't collide
                // Original .env is copied to .env.MA01, .env.MA02 etc. then patched.
                const envFilePath = path.join(svcPath, '.env');
                const machineEnvPath = path.join(svcPath, `.env.${machine.machineKey}`);

                // Copy original .env as the base for this machine's env if not yet done
                if (!fs.existsSync(machineEnvPath) && fs.existsSync(envFilePath)) {
                    fs.copyFileSync(envFilePath, machineEnvPath);
                }

                const patches: Record<string, string> = {
                    PORT: port.toString(),
                    MONGO_URI: mongoUri,
                    MONGODB_URI: mongoUri,
                };

                if (svc.name === 'app-device-interface') {
                    patches['MACHINE_ID'] = machine.machineId;
                }

                patchEnvFile(machineEnvPath, patches);

                const finalEnv = parseEnvFile(machineEnvPath);
                const pm2Name = `${PM2_PREFIX}-${svc.name}-${machine.machineKey}`;

                onLog(`[SPAWNER] ✅ ${pm2Name} → port ${port} | MACHINE_ID=${machine.machineId}`);

                ecosystemApps.push({
                    name: pm2Name,
                    script: svc.script,
                    interpreter: 'node',
                    interpreterArgs: ['--import', 'tsx'],
                    cwd: svcPath,
                    watch: false,
                    exec_mode: 'fork',
                    instances: 1,
                    autorestart: false,
                    env: finalEnv,
                });
            }
        }

        // ── SHARED services ─────────────────────────────────────────────────────
        // One instance each, port from sharedServicePorts.
        for (const svc of SHARED_SERVICES) {
            const svcPath = path.join(appsPath, svc.name);
            if (!fs.existsSync(svcPath)) {
                onLog(`[SPAWNER] ⚠️  ${svc.name} not found — skipping`);
                continue;
            }

            const port = sharedServicePorts[svc.name];
            if (!port) {
                onLog(`[SPAWNER] ⚠️  No port for shared service ${svc.name} — skipping`);
                continue;
            }

            if (!fs.existsSync(path.join(svcPath, 'node_modules'))) {
                onLog(`[SPAWNER] Installing deps for ${svc.name}...`);
                try {
                    await execAsync('npm install --ignore-scripts', { cwd: svcPath });
                } catch (e: any) {
                    onLog(`[SPAWNER] ⚠️  npm install failed for ${svc.name}: ${e.message}`);
                }
            }

            const envFilePath = path.join(svcPath, '.env');
            const patches: Record<string, string> = {
                PORT: port.toString(),
                MONGO_URI: mongoUri,
                MONGODB_URI: mongoUri,
            };
            patchEnvFile(envFilePath, patches);
            const finalEnv = parseEnvFile(envFilePath);

            onLog(`[SPAWNER] ✅ ${PM2_PREFIX}-${svc.name} → port ${port} (shared)`);

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
                env: finalEnv,
            });
        }

        if (ecosystemApps.length === 0) {
            return { success: false, error: 'No services could be built for ecosystem.' };
        }

        // Write ecosystem config
        const ecosystemContent = `module.exports = { apps: ${JSON.stringify(ecosystemApps, null, 2)} };`;
        fs.writeFileSync(ECOSYSTEM_PATH, ecosystemContent);
        onLog(`[SPAWNER] Ecosystem config written → ${ECOSYSTEM_PATH} (${ecosystemApps.length} apps)`);

        // Log the full manifest
        const perMachineCount = machines.length * PER_MACHINE_SERVICES.length;
        const sharedCount = SHARED_SERVICES.filter(s => sharedServicePorts[s.configKey]).length;
        onLog(`[SPAWNER] Manifest: ${perMachineCount} per-machine + ${sharedCount} shared = ${ecosystemApps.length} total`);

        // Start via PM2
        try {
            onLog(`[SPAWNER] Starting ${ecosystemApps.length} services via PM2...`);
            const { stdout, stderr } = await execAsync(`sudo pm2 start ${ECOSYSTEM_PATH}`, { timeout: 120000 });
            if (stdout) onLog(`[PM2] ${stdout.trim()}`);
            if (stderr) onLog(`[PM2] ${stderr.trim()}`);
        } catch (e: any) {
            return { success: false, error: `PM2 start failed: ${e.message?.split('\n')[0]}` };
        }

        onLog(`[SPAWNER] ✅ All services started via PM2`);

        // Stream PM2 logs to socket
        ServiceSpawner.streamPm2Logs(onLog);

        // Wait for the first machine's app-device-interface to confirm services are starting
        // (full readiness is confirmed by test-runner's waitForAllServices)
        const firstAppDevicePort = machines[0]?.services['app-device-interface']?.port || 5500;
        await ServiceSpawner.waitForPort(firstAppDevicePort, 60000, onLog);

        return { success: true };
    }

    // ── Fetch machine_services_config (legacy single-machine path) ───────────

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
            if (!doc.machine_services_config) throw new Error(`machine_services_config missing`);
            return doc.machine_services_config as Record<string, ServiceEndpoint>;
        } finally {
            await client.close();
        }
    }

    // ── Stop all automyrix PM2 processes ─────────────────────────────────────

    static async stopAll(sessionId: string, onLog: (msg: string) => void) {
        onLog(`[SPAWNER] Stopping previous PM2 processes (prefix: ${PM2_PREFIX})...`);
        try {
            const { stdout } = await execAsync(`sudo pm2 jlist`, { timeout: 10000 });
            const list: any[] = JSON.parse(stdout || '[]');
            const ours = list.filter(p => p.name?.startsWith(PM2_PREFIX)).map(p => p.name);

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

    // ── Stream PM2 logs ───────────────────────────────────────────────────────

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