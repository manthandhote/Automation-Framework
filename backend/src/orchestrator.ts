import { GitHandler } from './git-handler';
import { TestCaseBuilder } from './test-case-builder';
import axios from 'axios';
import { LlamaAnalyst } from './llama-analyst';
import { InspectraDB } from './inspectra-db';
import { CodeSummary } from './code-analyzer';
import { DbAnalyzer, DbSummary } from './db-analyzer';
import { TestRunner } from './test-runner';
//import { AdvancedSimulator } from './platform/advanced-simulator';
//import { LifecycleValidator } from './platform/lifecycle-validator';
import { E2ETestRunner, E2EReport } from './platform/e2e-test-runner';
//import { MongoClient } from 'mongodb';
//import { spawn, ChildProcess, exec } from 'child_process';
import { exec, ChildProcess } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';
import { emitToInfra, emitToInfraWithAck } from './index';

const execAsync = util.promisify(exec);

export interface ServiceInfo {
  name: string;
  port: number;
  status: 'UP' | 'DOWN';
  pid?: number;
}

export class Orchestrator {
  private services: ServiceInfo[] = [
    { name: 'app-device-interface', port: 5500, status: 'DOWN' },
    { name: 'incoming-service', port: 7002, status: 'DOWN' },
    { name: 'validation-engine', port: 5000, status: 'DOWN' },
    { name: 'mapper-service', port: 4000, status: 'DOWN' },
    { name: 'dataposting-service', port: 4100, status: 'DOWN' },
    { name: 'backend-for-frontend', port: 5026, status: 'DOWN' }
  ];

  private git: GitHandler;
  private llama: LlamaAnalyst;
  private inspectraDb: InspectraDB;
  private runningProcesses: Map<string, ChildProcess[]> = new Map();

  private readonly testDbUri = process.env.TEST_DB_URI || 'mongodb://127.0.0.1:27017';

  constructor(private workspacePath: string) {
    // Auto-resolve if path is missing or invalid
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      this.workspacePath = path.resolve(__dirname, '../..');
      logger.warn(`workspacePath invalid — auto-resolved to: ${this.workspacePath}`, 'ORCHESTRATOR');
    }
    this.git = new GitHandler(path.join(this.workspacePath, 'runs'));
    this.llama = new LlamaAnalyst();
    this.inspectraDb = InspectraDB.getInstance();
    logger.info(`Workspace: ${this.workspacePath}`, 'ORCHESTRATOR');
  }

  async buildSharedLibraries(bePath: string, onLog: (msg: string) => void) {
    const libs = ['shared-logger', 'shared-db', 'shared-server'];
    const libsRoot = path.join(bePath, 'libs');

    if (!fs.existsSync(libsRoot)) {
      onLog(`[WARNING] libs folder not found at ${libsRoot}`);
      return;
    }

    onLog(`[ORCHESTRATOR] Building shared libraries inside clone...`);

    for (const lib of libs) {
      const libPath = path.join(libsRoot, lib);

      if (!fs.existsSync(libPath)) {
        onLog(`[WARNING] ${lib} not found, skipping`);
        continue;
      }

      try {
        // 🛡️ AUTO-PATCH: Fix missing dependencies in shared-logger if they are empty
        if (lib === 'shared-logger') {
          const pkgPath = path.join(libPath, 'package.json');
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
              onLog(`[PATCH] Injecting missing dependencies into ${lib}...`);
              pkg.dependencies = pkg.dependencies || {};
              pkg.dependencies["pino"] = "^10.3.1";
              pkg.dependencies["pino-pretty"] = "^13.0.0";
              pkg.devDependencies = pkg.devDependencies || {};
              pkg.devDependencies["@types/node"] = "^20.0.0";
              fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
            }
          }
        }

        onLog(`➡ Installing ${lib}...`);
        await execAsync(`npm install --ignore-scripts`, { cwd: libPath });

        onLog(`➡ Building ${lib}...`);
        await execAsync(`npm run build`, { cwd: libPath });

        const distPath = path.join(libPath, 'dist');
        if (!fs.existsSync(distPath)) {
          throw new Error(`${lib} build failed: dist not created`);
        }

        onLog(`✅ ${lib} built`);
      } catch (err: any) {
        throw new Error(`❌ Failed building ${lib}: ${err.message}`);
      }
    }

    // 🔥 IMPORTANT: link libs via npm workspace
    onLog(`[ORCHESTRATOR] Installing root dependencies...`);
    await execAsync(`npm install --ignore-scripts`, { cwd: bePath });

    // 🔍 verify linking
    for (const lib of libs) {
      const checkPath = path.join(bePath, 'node_modules', '@nidoworkz', lib, 'dist', 'index.js');

      if (!fs.existsSync(checkPath)) {
        throw new Error(`❌ ${lib} not linked in node_modules`);
      }
    }

    onLog(`✅ All shared libs ready`);
  }

  async init() {
    await this.inspectraDb.connect();
    const runsDir = path.join(this.workspacePath, 'runs');
    if (!fs.existsSync(runsDir)) {
      fs.mkdirSync(runsDir);
      logger.info(`Created runs directory at ${runsDir}`, 'ORCHESTRATOR');
    }
    logger.info('Orchestrator initialized.', 'ORCHESTRATOR');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  Main entry points
  // ══════════════════════════════════════════════════════════════════════════════

  async coordinateRun(config: {
    sessionId: string;
    clientName: string;
    machineDescriptions: string;
    beRepo: string;
    beBranch: string;
    feRepo: string;
    feBranch: string;
    codeDir?: string;
    dbBackupPath?: string;
    testFilePath?: string;
  }, onLog: (msg: string) => void, onProgress?: (step: string, percent: number) => void) {

    onLog(`[ORCHESTRATOR] Starting enterprise run: ${config.sessionId} for client: ${config.clientName}`);
    onProgress?.('Initializing', 5);

    try {
      await this.inspectraDb.createSession({
        sessionId: config.sessionId,
        clientName: config.clientName,
        machineCount: 0,
        machineDescriptions: config.machineDescriptions,
        beRepo: config.beRepo,
        beBranch: config.beBranch,
        feRepo: config.feRepo,
        feBranch: config.feBranch,
        codeDir: config.codeDir || this.workspacePath,
        dbBackupPath: config.dbBackupPath,
        status: 'RUNNING',
        startedAt: new Date()
      });

      // ── STEP 1: Delegate repo setup + nginx config to VM infra-node ─────
      onLog(`[ORCHESTRATOR] Delegating repo setup to VM infra-node...`);
      onProgress?.('Setting Up VM', 10);

      try {
        await emitToInfraWithAck('infra:setup-project', {
          backendRepoUrl: config.beRepo,
          backendBranch: config.beBranch,
          frontendRepoUrl: config.feRepo,
          frontendBranch: config.feBranch,
          patToken: process.env.AZURE_PAT,
        }, 300000); // 5 min timeout for clone
        onLog(`[ORCHESTRATOR] VM repo setup complete.`);
      } catch (e: any) {
        onLog(`[WARNING] VM setup failed: ${e.message} — continuing with analysis`);
      }

      // ── STEP 2: Get code analysis + commit info FROM the VM (no local clone) ──
      onProgress?.('Analyzing Code on VM', 20);
      onLog(`[ORCHESTRATOR] Requesting code analysis from VM...`);

      let codeSummary: CodeSummary;
      try {
        const analyzeResult = await emitToInfraWithAck('infra:analyze-code', {
          bePath: '/data/NIDOWORKZ/CSND',
        }, 60000);
        codeSummary = analyzeResult.codeSummary;
        onLog(`[ORCHESTRATOR] VM code analysis complete: ${codeSummary.totalServices} services found.`);
      } catch (e: any) {
        onLog(`[WARNING] VM code analysis failed: ${e.message} — using fallback`);
        codeSummary = {
          totalServices: 0,
          services: [],
          sharedLibs: [],
          techStack: ['TypeScript', 'Node.js', 'Express', 'MongoDB'],
          framework: 'npm workspaces monorepo'
        };
      }

      let beCommit = 'unknown';
      let feCommit = 'unknown';
      try {
        const beInfo = await emitToInfraWithAck('infra:get-commit-info', { repoPath: '/data/NIDOWORKZ/CSND' }, 10000);
        beCommit = beInfo.metadata?.commit_id || 'unknown';
        onLog(`[GIT] BE Repo commit: ${beCommit} by ${beInfo.metadata?.author || 'unknown'}`);
      } catch { /* ignore */ }
      try {
        const feInfo = await emitToInfraWithAck('infra:get-commit-info', { repoPath: '/var/www/html' }, 10000);
        feCommit = feInfo.metadata?.commit_id || 'unknown';
      } catch { /* ignore */ }

      await this.inspectraDb.updateSession(config.sessionId, {
        beCommit,
        feCommit
      });

      // ── STEP 3: DB restore + analysis (runs on host, mongo is on host) ──
      const restoredDbName = `inspectra_csnd_${config.sessionId}`;
      let dbSummary: DbSummary | null = null;

      if (config.dbBackupPath && fs.existsSync(config.dbBackupPath)) {
        onLog(`[DB] Restoring MongoDB backup...`);
        onProgress?.('Restoring Database', 30);
        const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
        await dbAnalyzer.restoreBackup(config.dbBackupPath);
        await this.inspectraDb.updateSession(config.sessionId, { restoredDbName });
        dbSummary = await dbAnalyzer.analyze();
      }

      // ── STEP 4: LLM Analysis (runs on host, using codeSummary from VM) ───
      onLog(`[AI] Analyzing code + database...`);
      onProgress?.('AI Analysis', 50);

      if (!dbSummary) {
        dbSummary = {
          dbName: restoredDbName,
          totalMachines: 1,
          activeMachines: 1,
          machines: [{
            id: 'virtual-01',
            name: config.machineDescriptions || 'Default Machine',
            machine_key: 'MA01',
            type: 'sorter',
            location: 'Remote',
            status: true,
            configCount: 1,
            configs: []
          }],
          totalConfigs: 0,
          clients: [config.clientName],
          configTypes: {}
        };
      }

      await this.inspectraDb.updateSession(config.sessionId, { machineCount: dbSummary.totalMachines });

      const [codeInsights, dbInsights, scalingData] = await Promise.all([
        this.llama.analyzeCodebase(codeSummary),
        this.llama.analyzeDatabase(dbSummary),
        this.llama.analyzeConfig(dbSummary)
      ]);

      await this.inspectraDb.saveAnalysis({
        sessionId: config.sessionId,
        codeInsights, dbInsights,
        scalingPlan: scalingData.scaling,
        recommendations: scalingData.scaling.map((s: any) => `${s.service}: ${s.reason}`),
        generatedAt: new Date()
      });

      // ── STEP 5: Generate test cases (LLM on host) ────────────────────────
      onLog(`[AI] Generating test cases...`);
      onProgress?.('Generating Tests', 70);
      const testCases = await this.generateSessionTestCases(
        config.sessionId, codeSummary, restoredDbName, dbSummary
      );
      onLog(`[ORCHESTRATOR] Generated ${testCases.length} test cases.`);

      // ── STEP 6: Tell infra-node to spawn the microservices on the VM ────
      onLog(`[ORCHESTRATOR] Provisioning complete. Services will start when tests run.`);
      await this.inspectraDb.updateSession(config.sessionId, { status: 'COMPLETED' });
      onProgress?.('Ready', 100);

    } catch (err: any) {
      onLog(`[ERROR] Run failed: ${err.message}`);
      await this.inspectraDb.updateSession(config.sessionId, { status: 'FAILED', completedAt: new Date() });
      throw err;
    }

    return { status: 'PROVISIONED', sessionId: config.sessionId };
  }

  /*private async configureNginx(fePath: string, sessionId: string, onLog?: (msg: string) => void) {
    const simConfPath = 'C:/nginx/conf/sim_session.conf';
    const normalizedPath = fePath.replace(/\\/g, '/');

    const simConf = `
location /SIM/ {
    alias ${normalizedPath}/;
    index index.php index.html;

    location ~ \\.php$ {
        fastcgi_pass   127.0.0.1:9000;
        fastcgi_index  index.php;
        fastcgi_param  SCRIPT_FILENAME $request_filename;
        include        fastcgi_params;
    }
}
`;

    try {
      fs.writeFileSync(simConfPath, simConf);
      await execAsync('nginx -s reload');
      onLog?.(`[NGINX] Session frontend available at http://localhost:7001/SIM/`);
    } catch (e: any) {
      onLog?.(`[WARNING] nginx reload failed: ${e.message}`);
    }
  }*/

  async generateSessionTestCases(
    sessionId: string,
    providedCodeSummary: CodeSummary,
    restoredDbName: string,
    providedSummary?: DbSummary
  ): Promise<any[]> {
    let dbSummary = providedSummary;
    if (!dbSummary) {
      const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
      dbSummary = await dbAnalyzer.analyze();
    }

    const codeSummary = providedCodeSummary;

    // ✅ Call builder.buildWithLlm — NOT this.generateSessionTestCases
    const builder = new TestCaseBuilder(this.testDbUri, restoredDbName);
    const testCases = await builder.buildWithLlm(dbSummary, codeSummary);

    const casesWithMeta = testCases.map((tc, i) => ({
      ...tc,
      testId: tc.testId || `TC-${String(i + 1).padStart(3, '0')}`,
      sessionId,
      generatedBy: 'llm' as const,
      createdAt: new Date()
    }));

    await this.inspectraDb.deleteTestCases(sessionId);
    await this.inspectraDb.saveTestCases(casesWithMeta);
    logger.info(`[ORCHESTRATOR] Saved ${casesWithMeta.length} test cases for session ${sessionId}`, 'ORCHESTRATOR');
    return casesWithMeta;
  }


  async runFromReviewedCases(sessionId: string, onLog: (msg: string) => void, onProgress?: (step: string, percent: number) => void) {
    onLog(`[ORCHESTRATOR] Starting run from reviewed test cases for session: ${sessionId}`);
    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const testCases = await this.inspectraDb.getTestCases(sessionId);
    const dbName = session.restoredDbName || `inspectra_csnd_${sessionId}`;

    const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
    const dbSummary = await dbAnalyzer.analyze();

    const selectedMachine = dbSummary.machines.find(m => m.type?.toLowerCase() === 'astro')
      || dbSummary.machines.find(m => (m as any).machine_key)
      || dbSummary.machines[0];

    await this.executePhase(sessionId, '/data/NIDOWORKZ/CSND', dbName, testCases, onLog, onProgress, dbSummary, selectedMachine?.id);
  }

  getHealth(): ServiceInfo[] {
    return this.services;
  }

  /**
   * Run the full E2E test suite against the running microservices.
   * Sends real TCP protocol strings to app-device-interface and validates
   * the data flows through the entire pipeline.
   */
  async runE2ETests(
    sessionId: string,
    onLog: (msg: string) => void,
    onProgress?: (step: string, percent: number) => void
  ): Promise<E2EReport> {
    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const dbName = session.restoredDbName || `inspectra_csnd_${sessionId}`;

    onLog(`[E2E] Initializing E2E test runner for session: ${sessionId}`);
    onProgress?.('Starting E2E Tests', 10);

    const runner = new E2ETestRunner({
      tcpHost: '127.0.0.1',
      tcpPort: 3000,
      mongoUri: this.testDbUri,
      sessionDbName: dbName,
      machineKey: 'MA01',
    });

    // Forward logs to the caller
    runner.on('log', (msg: string) => onLog(msg));

    onProgress?.('Running Tests', 30);
    const report = await runner.run(sessionId);
    onProgress?.('Saving Results', 80);

    // Save each test result to inspectra_meta
    for (const result of report.results) {
      await this.inspectraDb.saveResult({
        sessionId,
        testId: result.testId,
        barcode: result.responses.join(' | '),
        service: 'e2e-pipeline',
        status: result.status as 'PASS' | 'FAIL' | 'ERROR',
        reason: result.reason,
        trace: {
          category: result.category,
          responses: result.responses,
          dbValidation: result.dbValidation,
          durationMs: result.durationMs,
        },
        executedAt: result.timestamp,
      });
    }

    // Update session status
    await this.inspectraDb.updateSession(sessionId, {
      status: report.failed > 0 || report.errors > 0 ? 'FAILED' : 'COMPLETED',
      completedAt: new Date(),
    });

    onProgress?.('Done', 100);
    onLog(`[E2E] ✅ Test suite complete: ${report.passed}/${report.totalTests} passed`);

    return report;
  }

  async fetchRemoteBranches(repoUrl: string): Promise<string[]> {
    return this.git.listRemoteBranches(repoUrl);
  }

  async rerunSession(
    sessionId: string,
    onLog: (msg: string) => void,
    onProgress?: (step: string, percent: number) => void
  ) {
    onLog(`[ORCHESTRATOR] Rerunning session: ${sessionId}`);

    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    try {
      await this.inspectraDb.updateSession(sessionId, { status: 'RUNNING', startedAt: new Date() });

      const dbName = session.restoredDbName || `inspectra_csnd_${sessionId}`;

      // Re-restore DB if backup exists (host-side mongo)
      if (session.dbBackupPath && fs.existsSync(session.dbBackupPath)) {
        onLog(`[ORCHESTRATOR] Re-restoring DB backup...`);
        const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
        await dbAnalyzer.restoreBackup(session.dbBackupPath);
      }

      const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
      const dbSummary = await dbAnalyzer.analyze();

      // Get code analysis from VM (no local clone needed)
      let codeSummary: CodeSummary;
      try {
        const analyzeResult = await emitToInfraWithAck('infra:analyze-code', {
          bePath: '/data/NIDOWORKZ/CSND',
        }, 60000);
        codeSummary = analyzeResult.codeSummary;
      } catch (e: any) {
        onLog(`[WARNING] VM code analysis failed: ${e.message} — using fallback`);
        codeSummary = {
          totalServices: 0, services: [], sharedLibs: [],
          techStack: ['TypeScript', 'Node.js', 'Express', 'MongoDB'],
          framework: 'npm workspaces monorepo'
        };
      }

      const testCases = await this.generateSessionTestCases(sessionId, codeSummary, dbName, dbSummary);

      const selectedMachine = dbSummary.machines.find(m =>
        (m as any).machine_key && m.name?.toLowerCase().includes('astro')
      ) || dbSummary.machines.find(m => m.type?.toLowerCase() === 'astro')
        || dbSummary.machines[0];

      onLog(`[ORCHESTRATOR] Selected machine: ${selectedMachine?.name} | key: ${(selectedMachine as any)?.machine_key}`);

      await this.executePhase(sessionId, '/data/NIDOWORKZ/CSND', dbName, testCases, onLog, onProgress, dbSummary, selectedMachine?.id);

    } catch (err: any) {
      onLog(`[ERROR] Re-run failed: ${err.message}`);
      await this.inspectraDb.updateSession(sessionId, { status: 'FAILED', completedAt: new Date() });
      throw err;
    }
  }

  async analyzeDiscoveredMachines(dbBackupPath: string) {
    if (!dbBackupPath) return { totalMachines: 0, machines: [] };
    const tempDbName = `temp_analysis_${Date.now()}`;
    const dbAnalyzer = new DbAnalyzer(this.testDbUri, tempDbName);
    try {
      // await this.ensureTestDb(() => { });  ← DELETE this line
      await dbAnalyzer.restoreBackup(dbBackupPath);
      const summary = await dbAnalyzer.analyze();
      return { totalMachines: summary.totalMachines, machines: summary.machines.map(m => m.name) };
    } catch (err) {
      console.error('DB Discovery failed:', err);
      throw err;
    }
  }

  private async executePhase(
    sessionId: string,
    bePath: string,
    dbName: string,
    testCases: any[],
    onLog: (msg: string) => void,
    onProgress?: (step: string, percent: number) => void,
    dbSummary?: DbSummary,
    selectedMachineId?: string
  ) {
    onProgress?.('Starting VM Services', 78);

    // ── Spawn services on VM first ─────────────────────────────────────────
    const selectedMachine = selectedMachineId
      ? dbSummary?.machines.find(m => m.id === selectedMachineId)
      : dbSummary?.machines[0];

    try {
      onLog?.(`[ORCHESTRATOR] Instructing VM to spawn microservices...`);
      await emitToInfraWithAck('infra:spawn-services', {
        sessionId,
        mongoUri: this.testDbUri,
        dbName,
        machineId: selectedMachine?.id || '',
        machineKey: (selectedMachine as any)?.machine_key || 'MA01',
      }, 120000);
      onLog?.(`[ORCHESTRATOR] VM services are up.`);
    } catch (e: any) {
      onLog?.(`[WARNING] VM service spawn issue: ${e.message} — proceeding`);
    }

    onProgress?.('Running Tests', 85);
    const runner = new TestRunner(this.testDbUri, this.workspacePath);
    const results = await runner.runAll(
      sessionId,
      testCases,
      dbSummary || { dbName, totalMachines: 1, activeMachines: 1, machines: [], totalConfigs: 0, clients: [], configTypes: {} },
      onLog
    );

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    onLog?.(`[ORCHESTRATOR] ✅ Tests complete: ${passed} passed, ${failed} failed`);

    await this.inspectraDb.updateSession(sessionId, {
      status: failed === 0 ? 'COMPLETED' : 'FAILED',
      completedAt: new Date()
    });
    onProgress?.('Done', 100);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private async ensureTestDb(onLog: (msg: string) => void) {
    const containerName = 'inspectra-test-mongo';
    const port = 27018;
    try {
      const { stdout: exists } = await execAsync(`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`);
      if (!exists.trim()) {
        onLog(`[DOCKER] Provisioning new test MongoDB...`);
        await execAsync(`docker run -d --name ${containerName} -p ${port}:27017 mongo:latest`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        const { stdout: running } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`);
        if (!running.trim()) {
          onLog(`[DOCKER] Starting test MongoDB...`);
          await execAsync(`docker start ${containerName}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } catch (e: any) {
      throw new Error(`Docker operation failed: ${e.message}`);
    }
  }


  private async spawnServices(
    _bePath: string,
    sessionId: string,
    onLog?: (msg: string) => void,
    dbSummary?: DbSummary,
    selectedMachineId?: string
  ) {
    // Services run on the VM. This is now handled via infra:spawn-services socket event.
    onLog?.(`[ORCHESTRATOR] Services are running on VM (delegated to infra-node)`);
  }

  private async stopServices(sessionId: string, onLog?: (msg: string) => void) {
    onLog?.(`[ORCHESTRATOR] Stopping services for ${sessionId}`);

    const processes = this.runningProcesses.get(sessionId);
    if (processes) {
      for (const p of processes) {
        try {
          if (p.pid) {
            // Windows-safe recursive kill
            onLog?.(`[ORCHESTRATOR] Force-killing process tree for PID ${p.pid}...`);
            await execAsync(`taskkill /F /T /PID ${p.pid}`);
          } else {
            p.kill();
          }
        } catch (e) {
          // Fallback to simple kill if taskkill fails
          try { p.kill(); } catch (k) { }
        }
      }
      this.runningProcesses.delete(sessionId);
    }

    // Also try PM2 cleanup just in case there are orphans
    for (const service of this.services) {
      try {
        await execAsync(`pm2 delete ${service.name}_${sessionId}`);
        service.status = 'DOWN';
      } catch (e) { }
    }
  }
}
