import { GitHandler } from './git-handler';
import { TestCaseBuilder } from './test-case-builder';
import axios from 'axios';
import { LlamaAnalyst } from './llama-analyst';
import { InspectraDB } from './inspectra-db';
import { CodeAnalyzer, CodeSummary } from './code-analyzer';
import { DbAnalyzer, DbSummary } from './db-analyzer';
import { TestRunner } from './test-runner';
import { AdvancedSimulator } from './platform/advanced-simulator';
import { LifecycleValidator } from './platform/lifecycle-validator';
import { E2ETestRunner, E2EReport } from './platform/e2e-test-runner';
import { MongoClient } from 'mongodb';
import { spawn, ChildProcess, exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

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
      // 1. Ensure DB (Graceful failure)
      try {
        await this.ensureTestDb(onLog);
      } catch (e: any) {
        onLog(`[WARNING] Test MongoDB provisioning failed: ${e.message}. Using fallback...`);
      }

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

      onLog(`[GIT] Preparing repositories...`);
      onProgress?.('Cloning Repositories', 15);
      const { targetPath: bePath, metadata: beMetadata } = await this.git.cloneOrUpdate(config.beRepo, `be_${config.sessionId}`, config.beBranch);
      const { targetPath: fePath, metadata: feMetadata } = await this.git.cloneOrUpdate(config.feRepo, `fe_${config.sessionId}`, config.feBranch);
      
      const prevSession = await this.inspectraDb.getLatestSessionForRepo(config.beRepo);
      const commitTag = (prevSession && prevSession.beCommit === beMetadata.commit_id) ? 'SAME_COMMIT' : 'NEW_COMMIT';
      onLog(`[GIT] BE Repo is at ${beMetadata.commit_id} (${commitTag}) by ${beMetadata.author}`);

      await this.inspectraDb.updateSession(config.sessionId, { beCommit: beMetadata.commit_id, feCommit: feMetadata.commit_id });

      await this.configureNginx(fePath, config.sessionId, onLog);  // ✅

      // BUILD LIBS INSIDE THE CLONE ONLY
      await this.buildSharedLibraries(bePath, onLog);

      // --- AUTO-PATCH env.php ---
      const envPhpPath = path.join(fePath, 'includes', 'env.php');
      if (fs.existsSync(envPhpPath)) {
        onLog(`[SYSTEM] Patching env.php for local development...`);
        let content = fs.readFileSync(envPhpPath, 'utf8');
        content = content.replace(/\$apibaseurl\s*=\s*["'][^"']+["']/g, '$apibaseurl = "127.0.0.1"');
        fs.writeFileSync(envPhpPath, content);
      }

      // --- AUTO-PATCH BFF MODELS ---
      const bffModelsPath = path.join(bePath, 'apps', 'backend-for-frontend', 'src', 'models');
      if (fs.existsSync(bffModelsPath)) {
        onLog(`[SYSTEM] Patching BFF models to support session isolation...`);
        const modelFiles = fs.readdirSync(bffModelsPath).filter(f => f.endsWith('.ts'));
        for (const file of modelFiles) {
          const filePath = path.join(bffModelsPath, file);
          let content = fs.readFileSync(filePath, 'utf8');

          const newContent = content.replace(
            /\.useDb\(['"]([^'"]+)['"]\s*,\s*\{[^}]+\}\)/g,
            (_, dbName) => `.useDb(process.env.MONGO_DB || '${dbName}', { useCache: true })`
          );

          if (content !== newContent) {
            fs.writeFileSync(filePath, newContent);
            onLog(`  - Patched ${file}`);
          }
        }
      }

      // --- AUTO-PATCH SHARED-DB ENGINE ---
      const sharedDbEnginePath = path.join(bePath, 'libs', 'shared-db', 'src', 'engines', 'MongoEngine.ts');
      if (fs.existsSync(sharedDbEnginePath)) {
        onLog(`[SYSTEM] Patching Shared-DB MongoEngine for session isolation...`);
        let content = fs.readFileSync(sharedDbEnginePath, 'utf8');
        // Force the engine to use MONGO_DB environment variable if available
        const newContent = content.replace(
          /this\.db = this\.client\.db\(dbName\);/g,
          `this.db = this.client.db(process.env.MONGO_DB || dbName);`
        );
        if (content !== newContent) {
          fs.writeFileSync(sharedDbEnginePath, newContent);
          onLog(`  - Patched MongoEngine.ts`);
        }
      }

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

      onLog(`[AI] Analyzing data + code...`);
      onProgress?.('AI Analysis', 50);

      const codeAnalyzer = new CodeAnalyzer(bePath);
      const codeSummary = await codeAnalyzer.analyze();

      // Create a virtual DB summary if none exists
      if (!dbSummary) {
        dbSummary = {
          dbName: restoredDbName,
          totalMachines: 1,
          activeMachines: 1,
          machines: [{
            id: 'virtual-01',
            name: config.machineDescriptions || 'Default Machine',
            machine_key: 'virtual-01',
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

      await this.inspectraDb.updateSession(config.sessionId, { machineCount: dbSummary!.totalMachines });

      const [codeInsights, dbInsights, scalingData] = await Promise.all([
        this.llama.analyzeCodebase(codeSummary),
        this.llama.analyzeDatabase(dbSummary!),
        this.llama.analyzeConfig(dbSummary!)
      ]);

      await this.inspectraDb.saveAnalysis({
        sessionId: config.sessionId,
        codeInsights, dbInsights,
        scalingPlan: scalingData.scaling,
        recommendations: scalingData.scaling.map(s => `${s.service}: ${s.reason}`),
        generatedAt: new Date()
      });

      onLog(`[AI] Generating test cases...`);
      onProgress?.('Generating Tests', 70);
      const testCases = await this.generateSessionTestCases(config.sessionId, bePath, restoredDbName, dbSummary);

      onLog(`[ORCHESTRATOR] Provisioning complete. Generated ${testCases.length} test cases.`);

      onLog(`[ORCHESTRATOR] Pre-starting services for session ${config.sessionId}...`);

      const selectedMachine = dbSummary!.machines.find(m =>
        m.type?.toLowerCase() === 'astro'
      ) || dbSummary!.machines.find(m =>
        (m as any).machine_key && m.name?.toLowerCase().includes('astro')
      ) || dbSummary!.machines[0];

      onLog(`[ORCHESTRATOR] Selected machine: ${selectedMachine?.name} | _id: ${selectedMachine?.id} | key: ${(selectedMachine as any)?.machine_key}`);

      await this.spawnServices(bePath, config.sessionId, onLog, dbSummary, selectedMachine?.id);

      await this.inspectraDb.updateSession(config.sessionId, { status: 'COMPLETED' });
      onProgress?.('Ready', 100);

    } catch (err: any) {
      onLog(`[ERROR] Run failed: ${err.message}`);
      await this.inspectraDb.updateSession(config.sessionId, { status: 'FAILED', completedAt: new Date() });
      await this.stopServices(config.sessionId, onLog);
      throw err;
    }
    return { status: 'PROVISIONED', sessionId: config.sessionId };
  }
  private async configureNginx(fePath: string, sessionId: string, onLog?: (msg: string) => void) {
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
}

  async generateSessionTestCases(
    sessionId: string,
    bePath: string,
    restoredDbName: string,
    providedSummary?: DbSummary
  ): Promise<any[]> {
    let dbSummary = providedSummary;
    if (!dbSummary) {
      const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
      dbSummary = await dbAnalyzer.analyze();
    }

    const codeAnalyzer = new CodeAnalyzer(bePath);
    const codeSummary = await codeAnalyzer.analyze();

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

    const bePath = path.join(this.workspacePath, 'runs', `be_${sessionId}`);
    const testCases = await this.inspectraDb.getTestCases(sessionId);
    const dbName = session.restoredDbName || `inspectra_csnd_${sessionId}`;

    const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
    const dbSummary = await dbAnalyzer.analyze();

    const selectedMachine = dbSummary.machines.find(m => m.type?.toLowerCase() === 'astro')
      || dbSummary.machines.find(m => (m as any).machine_key)
      || dbSummary.machines[0];

    await this.executePhase(sessionId, bePath, dbName, testCases, onLog, onProgress, dbSummary, selectedMachine?.id);
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

  async rerunSession(sessionId: string, onLog: (msg: string) => void, onProgress?: (step: string, percent: number) => void) {
    onLog(`[ORCHESTRATOR] Rerunning session: ${sessionId}`);

    // 1. Stop any existing services first to release locks
    await this.stopServices(sessionId, onLog);
    onLog(`[ORCHESTRATOR] Waiting for ports to be released...`);
    await new Promise(r => setTimeout(r, 3000)); // Give OS time to clear sockets

    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const bePath = path.join(this.workspacePath, 'runs', `be_${sessionId}`);

    if (!fs.existsSync(bePath)) {
      throw new Error(`Source code missing at: ${bePath}. Please run a full setup first.`);
    }

    const libsPath = path.join(bePath, 'libs');
    if (fs.existsSync(libsPath)) {
      await this.buildSharedLibraries(bePath, onLog);
    } else {
      onLog(`[WARNING] libs folder not found — skipping shared library build`);
    }

    try {
      await this.inspectraDb.updateSession(sessionId, { status: 'RUNNING', startedAt: new Date() });
      await this.ensureTestDb(onLog);

      const dbName = session.restoredDbName || `inspectra_csnd_${sessionId}`;
      const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);

      // 🛡️ CRITICAL: If session has a backup, we MUST restore it to ensure the DB exists for analysis/services
      if (session.dbBackupPath && fs.existsSync(session.dbBackupPath)) {
        onLog(`[ORCHESTRATOR] Restoring session backup from ${session.dbBackupPath}...`);
        await dbAnalyzer.restoreBackup(session.dbBackupPath);
      }

      onLog(`[ORCHESTRATOR] Verifying test database state...`);
      const summary = await dbAnalyzer.analyze();

      // Clone master machine configurations if missing
      if (summary.totalMachines === 0 || (summary.totalMachines === 1 && summary.machines[0].id === 'machine-1')) {
        onLog(`[ORCHESTRATOR] No machines found in session DB, cloning from master...`);
        const client = new MongoClient(this.testDbUri);
        try {
          await client.connect();
          const masterDb = client.db('machine_configurations');
          const sessionDb = client.db(dbName);
          const masterMachines = await masterDb.collection('machines').find().toArray();
          if (masterMachines.length > 0) {
            await sessionDb.collection('machines').insertMany(masterMachines);
            onLog(`[ORCHESTRATOR] Cloned ${masterMachines.length} machines from master to session.`);
            // Re-analyze after cloning
            const updatedSummary = await dbAnalyzer.analyze();
            Object.assign(summary, updatedSummary);
          }
        } catch (e: any) {
          onLog(`[WARNING] Failed to clone machines: ${e.message}`);
        } finally {
          await client.close();
        }
      }
      if (summary.totalMachines === 0 && session.dbBackupPath) {
        onLog(`[ORCHESTRATOR] Test database is empty. Re-restoring backup...`);
        await dbAnalyzer.restoreBackup(session.dbBackupPath);
      }

      const dbSummary = await dbAnalyzer.analyze();
      const codeAnalyzer = new CodeAnalyzer(bePath);
      const codeSummary = await codeAnalyzer.analyze();

      const testCases = await this.generateSessionTestCases(
        sessionId,
        bePath,
        dbName,
        dbSummary
      );

      const selectedMachine = dbSummary.machines.find(m =>
        (m as any).machine_key && m.name?.toLowerCase().includes('astro')
      ) || dbSummary.machines.find(m => m.type?.toLowerCase() === 'astro')
        || dbSummary.machines[0];

      const selectedMachineId = selectedMachine?.id;
      onLog(`[ORCHESTRATOR] Selected machine: ${selectedMachine?.name} | _id: ${selectedMachineId} | key: ${(selectedMachine as any)?.machine_key}`);

      await this.executePhase(sessionId, bePath, dbName, testCases, onLog, onProgress, dbSummary, selectedMachineId);
    } catch (err: any) {
      onLog(`[ERROR] Re-run failed: ${err.message}`);
      await this.inspectraDb.updateSession(sessionId, { status: 'FAILED', completedAt: new Date() });
      await this.stopServices(sessionId, onLog);
      throw err;
    }
  }

  async analyzeDiscoveredMachines(dbBackupPath: string): Promise<{ totalMachines: number, machines: string[] }> {
    if (!dbBackupPath) return { totalMachines: 0, machines: [] };

    const tempDbName = `temp_analysis_${Date.now()}`;
    const dbAnalyzer = new DbAnalyzer(this.testDbUri, tempDbName);

    try {
      await this.ensureTestDb(() => { });
      await dbAnalyzer.restoreBackup(dbBackupPath);
      const summary = await dbAnalyzer.analyze();
      return {
        totalMachines: summary.totalMachines,
        machines: summary.machines.map(m => m.name)
      };
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
    selectedMachineId?: string    // ← ADD THIS
  ) {
    onProgress?.('Executing Tests', 80);
    await this.spawnServices(bePath, sessionId, onLog, dbSummary, selectedMachineId);

    const baseUri = this.testDbUri.endsWith('/') ? this.testDbUri.slice(0, -1) : this.testDbUri;
    const sessionMongoUri = `${baseUri}/${dbName}`;

    // ✅ Replace with:
    onLog?.(`[ORCHESTRATOR] Simulation Environment is UP and READY.`);
    onLog?.(`[ORCHESTRATOR] Services are connected to: ${sessionMongoUri}`);

    // Wait for services to fully boot before running tests
    onLog?.(`[ORCHESTRATOR] Waiting for services to stabilize...`);
    await this.waitForServices(onLog);

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

    await this.inspectraDb.updateSession(sessionId, { status: failed === 0 ? 'COMPLETED' : 'FAILED', completedAt: new Date() });
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


  private async spawnServices(bePath: string, sessionId: string, onLog?: (msg: string) => void, dbSummary?: DbSummary, selectedMachineId?: string) {
    const appsPath = path.join(bePath, 'apps');

    const baseUri = this.testDbUri.endsWith('/')
      ? this.testDbUri.slice(0, -1)
      : this.testDbUri;

    const sessionMongoUri = `${baseUri}/inspectra_csnd_${sessionId}`;

    onLog?.(`[ORCHESTRATOR] Starting services...`);

    for (const service of this.services) {
      const servicePath = path.join(appsPath, service.name);
      if (!fs.existsSync(servicePath)) continue;

      // 🛡️ Safety: Ensure app node_modules exist
      if (!fs.existsSync(path.join(servicePath, 'node_modules'))) {
        onLog?.(`[ORCHESTRATOR] Installing dependencies for ${service.name}...`);
        try {
          await execAsync(`npm install --ignore-scripts`, { cwd: servicePath });
        } catch (e: any) {
          onLog?.(`[WARNING] App install failed for ${service.name}: ${e.message}`);
        }
      }

      const logFile = path.join(servicePath, 'service.log');
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      const dbPrefix = `inspectra_csnd_${sessionId}`;

      const envVars = {
        PORT: service.port.toString(),
        MONGO_URI: sessionMongoUri,
        MONGODB_URI: sessionMongoUri,
        NODE_ENV: 'development',
        SESSION_ID: sessionId,
        IS_SIMULATION: 'true',

        MONGO_DB: dbPrefix,
        SORTING_DB: dbPrefix,
        INCOMING_DB: dbPrefix,
        MACHINE_CONFIG_DB: dbPrefix,
        IDENTITY_DB: dbPrefix,
        CALIBRATION_DB: dbPrefix,
        NOTIFICATION_DB: dbPrefix,
        CYCLIC_DB: dbPrefix,
        UPLOADER_DB: dbPrefix,
      };

      if (service.name === 'app-device-interface' && (dbSummary?.machines?.length ?? 0) > 0) {
        const tcpMachine = (selectedMachineId 
          ? dbSummary!.machines.find(m => m.id === selectedMachineId)
          : null)
          || dbSummary!.machines.find(m => m.name?.toLowerCase().includes('astro'))
          || dbSummary!.machines[0];

        const machineKey = (tcpMachine as any).machine_key || 'MA01';

        // MACHINE_ID = the actual MongoDB _id (what app-device-interface queries by)
        // MACHINE_KEY = the protocol key (what goes into TCP packet strings)
        (envVars as any)['MACHINE_ID'] = tcpMachine.id;        // ← o1da5720-d2ee-4c8a-be37-43f216acc098
        (envVars as any)['MACHINE_KEY'] = machineKey;           // ← MA01
        
        onLog?.(`[ORCHESTRATOR] ADI machine: ${tcpMachine.name} | _id: ${tcpMachine.id} | key: ${machineKey}`);
      }

      fs.writeFileSync(
        path.join(servicePath, '.env'),
        Object.entries(envVars)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      );

      onLog?.(`➡ Starting ${service.name}...`);

      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn('npm', ['run', 'dev'], {
        cwd: servicePath,
        env: { ...process.env, ...envVars },
        shell: true,
        windowsHide: true   // suppress console popups per service
      });

      child.stdout?.on('data', (data) => {
        const msg = data.toString();
        onLog?.(`[${service.name}] ${msg}`);
        logStream.write(msg);
      });

      child.stderr?.on('data', (data) => {
        const msg = data.toString();
        onLog?.(`[${service.name} ERROR] ${msg}`);
        logStream.write(msg);
      });

      let sessionProcesses = this.runningProcesses.get(sessionId) || [];
      sessionProcesses.push(child);
      this.runningProcesses.set(sessionId, sessionProcesses);

      service.status = 'UP';

      await new Promise(res => setTimeout(res, 4000));
    }

    onLog?.(`✅ All services started`);
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
  private async waitForServices(onLog?: (msg: string) => void, timeoutMs: number = 60000): Promise<void> {
  const serviceChecks = [
    { name: 'app-device-interface', url: `http://127.0.0.1:5500/health` },
    { name: 'validation-engine',    url: `http://127.0.0.1:5000/health` },
    { name: 'incoming-service',     url: `http://127.0.0.1:7002/health` },
    { name: 'mapper-service',       url: `http://127.0.0.1:4000/health` },
    { name: 'dataposting-service',  url: `http://127.0.0.1:4100/health` },
  ];

  const startTime = Date.now();
  const pollIntervalMs = 3000;

  onLog?.(`[ORCHESTRATOR] Polling ${serviceChecks.length} services for readiness...`);

  while (Date.now() - startTime < timeoutMs) {
    const results = await Promise.all(
      serviceChecks.map(async (svc) => {
        try {
          const res = await axios.get(svc.url, { timeout: 2000 });
          return { name: svc.name, up: res.status < 500 };
        } catch {
          return { name: svc.name, up: false };
        }
      })
    );

    const allUp = results.every(r => r.up);
    const upNames = results.filter(r => r.up).map(r => r.name);
    const downNames = results.filter(r => !r.up).map(r => r.name);

    onLog?.(`[ORCHESTRATOR] Services UP: [${upNames.join(', ')}] | DOWN: [${downNames.join(', ')}]`);

    if (allUp) {
      onLog?.(`[ORCHESTRATOR] ✅ All services ready — starting simulation`);
      return;
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Timeout reached — log warning but proceed anyway
  onLog?.(`[ORCHESTRATOR] ⚠️ Timeout waiting for services — proceeding anyway`);
}
}
