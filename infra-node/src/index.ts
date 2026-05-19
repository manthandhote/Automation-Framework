import dotenv from 'dotenv';
dotenv.config();

import { io, Socket } from 'socket.io-client';
import os from 'os';
import { Installer } from './installer';
import { ServiceSpawner } from './service-spawner';
import { CodeAnalyzer } from './code-analyzer';
import { ProcessManager } from './process-manager';
import { MachineSimulator } from './simulator';
import { logger } from './logger';

function injectGithubToken(url: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return url;
  if (url.includes('@')) return url; // token already embedded
  return url.replace('https://', `https://${token}@`);
}

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const socket: Socket = io(ORCHESTRATOR_URL);
const processManager = new ProcessManager();

logger.info(`Connecting to AUTOMYRIX at ${ORCHESTRATOR_URL}...`);
// ── Setup CSND virtual serial + Modbus RTU slaves ─────────────────────────
socket.on('infra:setup-csnd', async (data: {
  machineId: string;
  machineKey: string;
  connectionPools: Array<{
    connection_id: number;
    type: string;
    port_name: string;
    baud_rate: number;
    slave_id: number;
    register_address: number;
  }>;
  devices: Array<{ device_id: number; data: string; connection_id: number }>;
  dimensionRegisters?: number[];
  weightRegisters?: number[];
}, callback: Function) => {
  logger.info(`[CSND] Setting up Modbus RTU simulation for ${data.machineKey}`);
  try {
    const { ModbusSimulator } = await import('./modbus-simulator');
    const sim = new ModbusSimulator((msg: string) => {
      logger.info(msg);
      socket.emit('infra:log', { message: msg });
    });

    if (data.dimensionRegisters) sim.setDimensionRegisters(data.dimensionRegisters);
    if (data.weightRegisters) sim.setWeightRegisters(data.weightRegisters);

    const portMap = await sim.setup(data.connectionPools, data.devices);

    // Store for teardown
    (global as any).__csndSims = (global as any).__csndSims || {};
    (global as any).__csndSims[data.machineId] = sim;

    logger.info(`[CSND] portMap: ${JSON.stringify(portMap)}`);
    callback({ success: true, portMap });
  } catch (err: any) {
    logger.error(`[CSND] Setup failed: ${err.message}`);
    callback({ success: false, error: err.message });
  }
});

// ── Simulate CSND barcode cycle ───────────────────────────────────────────
socket.on('infra:simulate-cycle-csnd', async (data: {
  barcode: string;
  machineId: string;
  machineKey: string;
  appDeviceHost: string;
  appDevicePort: number;
  mongoUri: string;
  timeoutMs?: number;
}, callback: Function) => {
  logger.info(`[CSND] Simulating cycle: ${data.barcode} on ${data.machineKey}`);
  try {
    const { CsndSimulator } = await import('./csnd-simulator');
    const sim = new CsndSimulator(
      data.appDeviceHost,
      data.appDevicePort,
      data.mongoUri,
      data.machineKey
    );
    const result = await sim.runCycle(data.barcode, data.machineId, data.timeoutMs ?? 15000);
    callback({ success: true, result });
  } catch (err: any) {
    logger.error(`[CSND] Cycle failed: ${err.message}`);
    callback({ success: false, error: err.message });
  }
});

// ── Teardown CSND socat + RTU slaves ──────────────────────────────────────
socket.on('infra:teardown-csnd', (data: { machineId: string }, callback: Function) => {
  const sims = (global as any).__csndSims || {};
  if (sims[data.machineId]) {
    sims[data.machineId].teardown();
    delete sims[data.machineId];
    logger.info(`[CSND] Teardown complete for ${data.machineId}`);
  }
  if (callback) callback({ success: true });
});
socket.on('connect', async () => {
  logger.info('Connected to AUTOMYRIX Orchestrator.');

  const vmInfo = {
    hostname: os.hostname(),
    os: os.platform(),
    release: os.release(),
    cpuCount: os.cpus().length,
    totalMem: Math.round(os.totalmem() / 1024 / 1024),
    freeMem: Math.round(os.freemem() / 1024 / 1024)
  };

  socket.emit('infra:register', vmInfo);

  const nginxStatus = await Installer.checkAndInstallNginx();
  const phpStatus = await Installer.checkAndInstallPhp();
  const gitStatus = await Installer.checkAndInstallGit();
  const mongoStatus = await Installer.checkAndInstallMongo();

  socket.emit('infra:status', {
    nginx: nginxStatus ? 'running' : 'not running',
    php: phpStatus ? 'installed' : 'not installed',
    git: gitStatus ? 'installed' : 'not installed',
    mongo: mongoStatus ? 'installed' : 'not installed',
    status: (nginxStatus && phpStatus && gitStatus && mongoStatus) ? 'PASS' : 'FAIL'
  });
});
// ── Clone DB repo on VM and return client folder list ─────────────────────
socket.on('infra:clone-db-repo', async (
  payload: { repoUrl: string },
  callback: Function
) => {
  const repoUrl = injectGithubToken(payload.repoUrl);
  logger.info(`[clone-db-repo] Cloning/updating repo on VM...`);

  try {
    const { exec: execCb } = require('child_process');
    const util = require('util');
    const fs = require('fs');
    const path = require('path');
    const execP = util.promisify(execCb);

    const repoLocalPath = '/tmp/db-repo';

    if (fs.existsSync(path.join(repoLocalPath, '.git'))) {
      logger.info('[restore-db] Repo already cloned — resetting to latest...');
      try {
        // Update stored origin URL to include token (fixes stale credential-free URL)
        await execP(`git -C "${repoLocalPath}" remote set-url origin "${repoUrl}"`, { timeout: 5000 });
        await execP(`git -C "${repoLocalPath}" fetch origin`, { timeout: 60000 });
        await execP(`git -C "${repoLocalPath}" reset --hard origin/HEAD`, { timeout: 10000 });
      } catch (fetchErr: any) {
        logger.warn(`[restore-db] Fetch failed — using existing clone as-is. ${fetchErr.message?.split('\n')[0]}`);
      }
    } else {
      logger.info(`[clone-db-repo] Fresh clone...`);
      if (fs.existsSync(repoLocalPath)) {
        fs.rmSync(repoLocalPath, { recursive: true, force: true });
      }
      await execP(`git clone "${repoUrl}" "${repoLocalPath}"`, { timeout: 180000 });
    }

    // Walk configs/ to find all client folders (same logic as before)
    const configsPath = path.join(repoLocalPath, 'configs');
    if (!fs.existsSync(configsPath)) {
      return callback({ success: false, error: 'No "configs" folder found in repo root.' });
    }

    const clients: string[] = [];
    const walk = (dir: string, prefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasCollections = entries.some((e: any) => e.isDirectory() && e.name === 'collections');
      if (hasCollections) { clients.push(prefix); return; }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'collections') {
          walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
    };

    const topLevel = fs.readdirSync(configsPath, { withFileTypes: true });
    for (const entry of topLevel) {
      if (entry.isDirectory()) {
        walk(path.join(configsPath, entry.name), entry.name);
      }
    }

    logger.info(`[clone-db-repo] Found ${clients.length} client(s): ${clients.join(', ')}`);
    callback({ success: true, clients });

  } catch (err: any) {
    logger.error(`[clone-db-repo] Failed: ${err.message?.split('\n')[0]}`);
    callback({ success: false, error: err.message });
  }
});

socket.on('infra:start-service', (data: { serviceName: string, servicePath: string, port: number }) => {
  const success = processManager.startService(data.serviceName, data.servicePath, data.port);
  socket.emit('infra:service-status', { serviceName: data.serviceName, status: success ? 'UP' : 'FAILED' });
});

socket.on('infra:stop-service', (data: { serviceName: string }) => {
  const success = processManager.stopService(data.serviceName);
  socket.emit('infra:service-status', { serviceName: data.serviceName, status: success ? 'DOWN' : 'FAILED' });
});

// ── Clone repos + configure nginx on the VM ───────────────────────────────
socket.on('infra:setup-project', async (data: {
  backendRepoUrl: string;
  backendBranch: string;
  frontendRepoUrl: string;
  frontendBranch: string;
  patToken?: string;
}, callback: Function) => {

  logger.info(`PAT received: ${data.patToken ? `YES (length: ${data.patToken.length})` : 'NO — undefined'}`);
  logger.info('Received infra:setup-project — setting up repos on VM...');

  const result = await Installer.setupProjectRepos(
    data.backendRepoUrl,
    data.backendBranch,
    data.frontendRepoUrl,
    data.frontendBranch,
    (msg: string) => {
      logger.info(`[setup] ${msg}`);
      socket.emit('infra:log', { message: `[SETUP] ${msg}` });
    },
    data.patToken
  );

  if (callback) callback(
    result.success
      ? { success: true }
      : { success: false, error: result.error }
  );
});

// ── Spawn all microservices on the VM ─────────────────────────────────────
socket.on('infra:spawn-services', async (data: {
  sessionId: string;
  mongoUri: string;
  dbName: string;
  // Legacy single-machine fields
  machineId: string;
  machineKey: string;
  // New multi-machine fields
  machines?: Array<{
    machineId: string;
    machineKey: string;
    machineName?: string;
    tcpPort?: number;
    services: Record<string, { port: number }>;
  }>;
  sharedServices?: Record<string, { port: number }>;
  totalMachines?: number;
}, callback: Function) => {
  logger.info(`Received infra:spawn-services for session ${data.sessionId}`);

  if (data.machines && data.machines.length > 0) {
    logger.info(`[SPAWNER] Multi-machine mode: ${data.machines.length} machine(s)`);
    for (const m of data.machines) {
      const ports = Object.entries(m.services).map(([k, v]) => `${k}:${v.port}`).join(', ');
      logger.info(`  • ${m.machineKey} (${m.machineId}) — ${ports}`);
    }
  } else {
    logger.info(`[SPAWNER] Single-machine mode: ${data.machineKey} (${data.machineId})`);
  }

  const result = await ServiceSpawner.spawnAll({
    bePath: '/data/NIDOWORKZ/CSND',
    sessionId: data.sessionId,
    mongoUri: data.mongoUri,
    dbName: data.dbName,
    // Legacy fields (still needed for fallback path in spawnAll)
    machineId: data.machineId,
    machineKey: data.machineKey,
    // New multi-machine fields
    machines: data.machines,
    sharedServices: data.sharedServices,
    onLog: (msg: string) => {
      logger.info(msg);
      socket.emit('infra:log', { message: msg });
    }
  });

  if (callback) callback(
    result.success
      ? { success: true }
      : { success: false, error: result.error }
  );
});

// ── Simulate hardware cycle ───────────────────────────────────────────────
socket.on('infra:simulate-cycle', async (data: any, callback: Function) => {
  logger.info(`Simulating cycle for ${data.barcode} on ${data.machineKey} (edge: ${data.edgeProfile ?? 'NORMAL'})`);
  try {
    // MachineSimulator now takes a single options object:
    //   { host, port, machineKey }
    // data.options may carry host/port from the host, data.machineKey is the machine identifier.
    const simulator = new MachineSimulator({
      host: data.options?.host ?? '127.0.0.1',
      port: data.options?.port ?? 3000,
      machineKey: data.machineKey ?? 'MA01',
    });

    simulator.on('packet', (packetInfo) => {
      socket.emit('simulator:packet', { data: packetInfo });
    });

    simulator.on('log', (msg: string) => {
      socket.emit('infra:log', { message: msg });
    });

    // runCycle signature:
    //   runCycle(barcode, dims, weight, edgeProfile, tidOverride?)
    // Normalize dims: backend may send { l, b, h } or { l, w, h } — always produce valid { l, w, h }
    const rawDims: any = data.dims ?? {};
    const normDims = {
      l: Number(rawDims.l) || 187,
      w: Number(rawDims.w ?? rawDims.b) || 172,  // accept 'w' (width) OR 'b' (breadth)
      h: Number(rawDims.h) || 47,
    };
    const result = await simulator.runCycle(
      data.barcode,
      normDims,
      data.weight ?? 0.12,
      data.edgeProfile ?? 'NORMAL',
    );

    if (callback) callback({ success: true, result });
  } catch (err: any) {
    logger.error({ err }, 'Simulation cycle failed');
    if (callback) callback({ success: false, error: err.message });
  }
});

// ── Analyze code on VM (so host doesn't need to clone) ────────────────────
socket.on('infra:analyze-code', async (data: { bePath: string }, callback: Function) => {
  const codePath = data.bePath || '/data/NIDOWORKZ/CSND';
  logger.info(`Running CodeAnalyzer on ${codePath}...`);
  try {
    const analyzer = new CodeAnalyzer(codePath);
    const summary = await analyzer.analyze();
    if (callback) callback({ success: true, codeSummary: summary });
  } catch (err: any) {
    logger.error(`Code analysis failed: ${err.message}`);
    if (callback) callback({ success: false, error: err.message });
  }
});

// ── Get git commit info from VM clone ─────────────────────────────────────
socket.on('infra:get-commit-info', async (data: { repoPath: string }, callback: Function) => {
  const repoPath = data.repoPath || '/data/NIDOWORKZ/CSND';
  try {
    const { exec: execCb } = require('child_process');
    const util = require('util');
    const execP = util.promisify(execCb);

    await execP(`git config --global --add safe.directory ${repoPath}`, { timeout: 10000 }).catch(() => { });

    const { stdout } = await execP(
      `git -C ${repoPath} log -1 --format='{"commit_id":"%H","author":"%an","message":"%s","timestamp":"%ai"}'`,
      { timeout: 10000 }
    );
    const metadata = JSON.parse(stdout.trim());
    if (callback) callback({ success: true, metadata });
  } catch (err: any) {
    logger.error(`Git metadata fetch failed: ${err.message}`);
    if (callback) callback({ success: false, error: err.message });
  }
});

// ── Restore DB on VM ────────────────────────────────────────────────────────
//
//  NEW FLOW (replaces mongorestore --archive):
//
//  Payload: { repoUrl: string, clientFolder: string }
//
//  Steps:
//    1. Clone / pull the DataBase_Reference GitHub repo into /tmp/db-repo
//    2. Resolve the collections folder:
//         /tmp/db-repo/configs/<clientFolder>/collections/
//    3. For every *.json file in that folder, derive db + collection from
//       the filename convention:
//         <db_name>.<collection_name>.json
//         e.g. incoming_service.incoming_config.json
//              → mongoimport --db incoming_service --collection incoming_config
//    4. Run mongoimport --drop --jsonArray for each file.
//    5. ACK the orchestrator when done (or forward the error).
//
// ────────────────────────────────────────────────────────────────────────────
socket.on('infra:restore-db', async (
  payload: { repoUrl: string; clientFolder: string },
  callback: Function
) => {
  const repoUrl = injectGithubToken(payload.repoUrl);
  const { clientFolder } = payload;
  logger.info(`[restore-db] repo=<token-injected>  client=${clientFolder}`);

  try {
    const { exec: execCb } = require('child_process');
    const util = require('util');
    const fs = require('fs');
    const path = require('path');
    const execP = util.promisify(execCb);

    // ── 1. Clone or pull ────────────────────────────────────────────────
    const repoLocalPath = '/tmp/db-repo';

    if (fs.existsSync(path.join(repoLocalPath, '.git'))) {
      logger.info('[restore-db] Repo already cloned — resetting to latest...');
      try {
        // Update stored origin URL to include token (fixes stale credential-free URL)
        await execP(`git -C "${repoLocalPath}" remote set-url origin "${repoUrl}"`, { timeout: 5000 });
        await execP(`git -C "${repoLocalPath}" fetch origin`, { timeout: 60000 });
        await execP(`git -C "${repoLocalPath}" reset --hard origin/HEAD`, { timeout: 10000 });
      } catch (fetchErr: any) {
        logger.warn(`[restore-db] Fetch failed — using existing clone as-is. ${fetchErr.message?.split('\n')[0]}`);
      }
    } else {
      logger.info(`[restore-db] Cloning ${repoUrl} ...`);
      if (fs.existsSync(repoLocalPath)) {
        fs.rmSync(repoLocalPath, { recursive: true, force: true });
      }
      await execP(`git clone "${repoUrl}" "${repoLocalPath}"`, { timeout: 180000 });
    }

    // ── 2. Locate the collections folder ───────────────────────────────
    const collectionsPath = path.join(repoLocalPath, 'configs', clientFolder, 'collections');

    if (!fs.existsSync(collectionsPath)) {
      throw new Error(
        `collections folder not found at configs/${clientFolder}/collections — ` +
        `check the clientFolder value sent from the orchestrator.`
      );
    }

    // ── 3. Enumerate JSON files ─────────────────────────────────────────
    const files: string[] = fs
      .readdirSync(collectionsPath)
      .filter((f: string) => f.endsWith('.json'));

    if (files.length === 0) {
      throw new Error(`No .json files found in ${collectionsPath}`);
    }

    logger.info(`[restore-db] Found ${files.length} collection file(s) — starting import...`);

    // ── 4. mongoimport per file ─────────────────────────────────────────
    for (const file of files) {
      // filename format: <db>.<collection>.json
      // Split on the FIRST dot only to handle db names that don't contain dots,
      // then treat everything between the first and last dot as the collection.
      const withoutExt = file.slice(0, -5);          // strip .json
      const firstDot = withoutExt.indexOf('.');
      if (firstDot === -1) {
        logger.warn(`[restore-db] Skipping "${file}" — does not match <db>.<collection>.json`);
        continue;
      }

      const dbName = withoutExt.slice(0, firstDot);
      const collectionName = withoutExt.slice(firstDot + 1);
      const filePath = path.join(collectionsPath, file);

      logger.info(`[restore-db]   importing ${dbName} → ${collectionName} from ${file}`);

      const { stderr } = await execP(
        `mongoimport \
          --uri="mongodb://127.0.0.1:27017" \
          --db="${dbName}" \
          --collection="${collectionName}" \
          --drop \
          --jsonArray \
          --file="${filePath}"`,
        { timeout: 120000 }
      );

      // mongoimport writes progress to stderr — only log real problems
      if (stderr) {
        const firstLine = stderr.split('\n')[0];
        if (!firstLine.toLowerCase().includes('connected') &&
          !firstLine.toLowerCase().includes('imported')) {
          logger.warn(`[restore-db] mongoimport stderr (${file}): ${firstLine}`);
        }
      }
    }

    logger.info('[restore-db] ✅ All collections restored via mongoimport.');
    if (callback) callback({ success: true });

  } catch (err: any) {
    logger.error(`[restore-db] ❌ Failed: ${err.message?.split('\n')[0]}`);
    if (callback) callback({ success: false, error: err.message });
  }
});