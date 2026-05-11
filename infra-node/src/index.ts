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

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const socket: Socket = io(ORCHESTRATOR_URL);
const processManager = new ProcessManager();

logger.info(`Connecting to AUTOMYRIX at ${ORCHESTRATOR_URL}...`);

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
  patToken?: string;        // ← ADD THIS
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
  machineId: string;
  machineKey: string;
}, callback: Function) => {
  logger.info(`Received infra:spawn-services for session ${data.sessionId}`);

  const result = await ServiceSpawner.spawnAll({
    bePath: '/data/NIDOWORKZ/CSND',
    sessionId: data.sessionId,
    mongoUri: data.mongoUri,
    dbName: data.dbName,
    machineId: data.machineId,
    machineKey: data.machineKey,
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
  logger.info(`Simulating cycle for ${data.barcode} on ${data.machineKey} (${data.protocol})`);
  try {
    const simulator = new MachineSimulator(data.transport, data.options);

    simulator.on('packet', (packetStr) => {
      socket.emit('simulator:packet', { data: packetStr });
    });

    const result = await simulator.runFullCycle(
      data.barcode,
      data.machineKey,
      data.protocol,
      data.dims,
      data.weight,
      data.edgeProfile
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

    // Add safe.directory exception since repos might be owned by root
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
socket.on('infra:restore-db', async (payload: { archivePath: string; dbName: string }, callback: Function) => {
  const { archivePath, dbName } = payload;
  logger.info(`[restore-db] Restoring ${archivePath} → ${dbName}...`);

  try {
    const { exec: execCb } = require('child_process');
    const util = require('util');
    const execP = util.promisify(execCb);

    const { stdout, stderr } = await execP(
      `mongorestore --uri="mongodb://127.0.0.1:27017" \
       --archive="${archivePath}" --drop`,
      { timeout: 300000 }
    );
    if (stderr && !stderr.includes('done')) {
      logger.warn(`[restore-db] stderr: ${stderr.split('\n')[0]}`);
    }
    logger.info('[restore-db] ✅ Restore complete.');
    if (callback) callback({ success: true });
  } catch (err: any) {
    logger.error(`[restore-db] Failed: ${err.message?.split('\n')[0]}`);
    if (callback) callback({ success: false, error: err.message });
  }
});

socket.on('disconnect', () => {
  logger.info('Disconnected from Orchestrator.');
});