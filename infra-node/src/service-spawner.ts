import { spawn, ChildProcess } from 'child_process';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const execAsync = util.promisify(exec);

const SERVICES = [
    { name: 'app-device-interface', port: 3000 },
    { name: 'incoming-service', port: 7002 },
    { name: 'validation-engine', port: 5000 },
    { name: 'mapper-service', port: 4000 },
    { name: 'dataposting-service', port: 4100 },
    { name: 'backend-for-frontend', port: 5026 },
];

// Store running processes so we can kill them on re-run
const runningProcesses: Map<string, ChildProcess[]> = new Map();

export interface SpawnConfig {
    bePath: string;
    sessionId: string;
    mongoUri: string;
    dbName: string;
    machineId: string;
    machineKey: string;
    onLog: (msg: string) => void;
}

export class ServiceSpawner {

    static async spawnAll(config: SpawnConfig): Promise<{ success: boolean; error?: string }> {
        const { bePath, sessionId, mongoUri, dbName, machineId, machineKey, onLog } = config;

        // Kill any previously running services for this session
        await ServiceSpawner.stopAll(sessionId, onLog);

        const appsPath = path.join(bePath, 'apps');

        if (!fs.existsSync(appsPath)) {
            return { success: false, error: `apps/ folder not found at ${bePath}` };
        }

        // Build shared libs first
        try {
            await ServiceSpawner.buildSharedLibs(bePath, onLog);
        } catch (e: any) {
            return { success: false, error: `Shared lib build failed: ${e.message}` };
        }

        const sessionProcesses: ChildProcess[] = [];

        for (const svc of SERVICES) {
            const svcPath = path.join(appsPath, svc.name);
            if (!fs.existsSync(svcPath)) {
                onLog(`[SPAWNER] ⚠️  ${svc.name} not found at ${svcPath} — skipping`);
                continue;
            }

            // Install node_modules if missing
            if (!fs.existsSync(path.join(svcPath, 'node_modules'))) {
                onLog(`[SPAWNER] Installing deps for ${svc.name}...`);
                try {
                    await execAsync('npm install --ignore-scripts', { cwd: svcPath });
                } catch (e: any) {
                    onLog(`[SPAWNER] ⚠️  npm install failed for ${svc.name}: ${e.message}`);
                }
            }

            const envVars: Record<string, string> = {
                PORT: svc.port.toString(),
                MONGO_URI: mongoUri,
                MONGODB_URI: mongoUri,
                NODE_ENV: 'development',
                SESSION_ID: sessionId,
                IS_SIMULATION: 'true',
                MONGO_DB: dbName,
                SORTING_DB: dbName,
                INCOMING_DB: dbName,
                MACHINE_CONFIG_DB: dbName,
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

            onLog(`[SPAWNER] ➡ Starting ${svc.name} on port ${svc.port}...`);

            const child = spawn('npm', ['run', 'dev'], {
                cwd: svcPath,
                env: { ...process.env, ...envVars },
                shell: true,
            });

            child.stdout?.on('data', (d) => onLog(`[${svc.name}] ${d.toString().trim()}`));
            child.stderr?.on('data', (d) => onLog(`[${svc.name} ERR] ${d.toString().trim()}`));
            child.on('exit', (code) => onLog(`[${svc.name}] exited with code ${code}`));

            sessionProcesses.push(child);

            // Stagger service starts
            await new Promise(r => setTimeout(r, 3000));
        }

        runningProcesses.set(sessionId, sessionProcesses);
        onLog(`[SPAWNER] ✅ All services started on VM`);

        // Wait for app-device-interface TCP port 3000 to be ready
        await ServiceSpawner.waitForPort(3000, 60000, onLog);

        return { success: true };
    }

    static async stopAll(sessionId: string, onLog: (msg: string) => void) {
        const procs = runningProcesses.get(sessionId);
        if (procs) {
            onLog(`[SPAWNER] Stopping ${procs.length} services for session ${sessionId}...`);
            for (const p of procs) {
                try { p.kill('SIGTERM'); } catch (_) { }
            }
            runningProcesses.delete(sessionId);
        }
    }

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

            // Auto-patch shared-logger deps if empty
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