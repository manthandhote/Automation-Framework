import { GitHandler } from './core/git-handler';
import { TestCaseBuilder } from './test-cases/test-case-builder';
import { LlamaAnalyst } from './test-cases/llama-analyst';
import { InspectraDB } from './core/inspectra-db';
import { CodeSummary } from './core/code-analyzer';
import { DbAnalyzer, DbSummary } from './core/db-analyzer';
import { TestRunner } from './backend-tests/test-runner';
import { E2ETestRunner, E2EReport } from './backend-tests/platform/e2e-test-runner';
import { IncomingDataSeeder } from './core/incoming-data-seeder';  // ← NEW
import { MongoClient } from 'mongodb';
import { exec, ChildProcess } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from './core/logger';
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

  private testDbUri = process.env.TEST_DB_URI || 'mongodb://127.0.0.1:27017';
  public vmIp: string = '';

  constructor(private workspacePath: string) {
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      this.workspacePath = path.resolve(__dirname, '../..');
      logger.warn(`workspacePath invalid — auto-resolved to: ${this.workspacePath}`, 'ORCHESTRATOR');
    }
    this.git = new GitHandler(path.join(this.workspacePath, 'runs'));
    this.llama = new LlamaAnalyst();
    this.inspectraDb = InspectraDB.getInstance();
    logger.info(`Workspace: ${this.workspacePath}`, 'ORCHESTRATOR');
  }

  public setVmIp(ip: string) {
    this.vmIp = ip;
    this.testDbUri = `mongodb://${ip}:27017`;
    process.env.TEST_DB_URI = this.testDbUri;
    logger.info(`Updated TEST_DB_URI to ${this.testDbUri}`, 'ORCHESTRATOR');
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

  async buildSharedLibraries(bePath: string, onLog: (msg: string) => void) {
    const libs = ['shared-logger', 'shared-db', 'shared-server'];
    const libsRoot = path.join(bePath, 'libs');
    if (!fs.existsSync(libsRoot)) { onLog(`[WARNING] libs folder not found at ${libsRoot}`); return; }
    onLog(`[ORCHESTRATOR] Building shared libraries inside clone...`);
    for (const lib of libs) {
      const libPath = path.join(libsRoot, lib);
      if (!fs.existsSync(libPath)) { onLog(`[WARNING] ${lib} not found, skipping`); continue; }
      try {
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
        if (!fs.existsSync(distPath)) throw new Error(`${lib} build failed: dist not created`);
        onLog(`✅ ${lib} built`);
      } catch (err: any) {
        throw new Error(`❌ Failed building ${lib}: ${err.message}`);
      }
    }
    onLog(`[ORCHESTRATOR] Installing root dependencies...`);
    await execAsync(`npm install --ignore-scripts`, { cwd: bePath });
    for (const lib of libs) {
      const checkPath = path.join(bePath, 'node_modules', '@nidoworkz', lib, 'dist', 'index.js');
      if (!fs.existsSync(checkPath)) throw new Error(`❌ ${lib} not linked in node_modules`);
    }
    onLog(`✅ All shared libs ready`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  Main entry point
  // ══════════════════════════════════════════════════════════════════════════════

  async coordinateRun(config: {
    sessionId: string;
    clientName: string;
    machineDescriptions: string;
    beRepo: string;
    machineIds?: string[];
    beBranch: string;
    feRepo: string;
    feBranch: string;
    codeDir?: string;
    dbRepoUrl?: string;
    dbClientFolder?: string;
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
        dbRepoUrl: config.dbRepoUrl,
        dbClientFolder: config.dbClientFolder,
        machineIds: config.machineIds,
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
        }, 300000);
        onLog(`[ORCHESTRATOR] VM repo setup complete.`);
      } catch (e: any) {
        onLog(`[WARNING] VM setup failed: ${e.message} — continuing with analysis`);
      }

      // ── STEP 2: Get code analysis + commit info FROM the VM ──────────────
      onProgress?.('Analyzing Code on VM', 20);
      onLog(`[ORCHESTRATOR] Requesting code analysis from VM...`);
      let codeSummary: CodeSummary;
      try {
        const analyzeResult = await emitToInfraWithAck('infra:analyze-code', { bePath: '/data/NIDOWORKZ/CSND' }, 60000);
        codeSummary = analyzeResult.codeSummary;
        onLog(`[ORCHESTRATOR] VM code analysis complete: ${codeSummary.totalServices} services found.`);
      } catch (e: any) {
        onLog(`[WARNING] VM code analysis failed: ${e.message} — using fallback`);
        codeSummary = { totalServices: 0, services: [], sharedLibs: [], techStack: ['TypeScript', 'Node.js', 'Express', 'MongoDB'], framework: 'npm workspaces monorepo' };
      }

      let beCommit = 'unknown', feCommit = 'unknown';
      try {
        const beInfo = await emitToInfraWithAck('infra:get-commit-info', { repoPath: '/data/NIDOWORKZ/CSND' }, 10000);
        beCommit = beInfo.metadata?.commit_id || 'unknown';
        onLog(`[GIT] BE Repo commit: ${beCommit} by ${beInfo.metadata?.author || 'unknown'}`);
      } catch { }
      try {
        const feInfo = await emitToInfraWithAck('infra:get-commit-info', { repoPath: '/var/www/html' }, 10000);
        feCommit = feInfo.metadata?.commit_id || 'unknown';
      } catch { }

      await this.inspectraDb.updateSession(config.sessionId, { beCommit, feCommit });

      // ── STEP 3: DB restore via GitHub repo → VM ──────────────────────────
      const restoredDbName = 'inspectra_csnd';
      let dbSummary: DbSummary | null = null;

      if (config.dbRepoUrl && config.dbClientFolder) {
        onLog(`[DB] Restoring collections from GitHub repo on VM...`);
        onProgress?.('Restoring Database', 30);

        await emitToInfraWithAck('infra:restore-db', {
          repoUrl: config.dbRepoUrl,
          clientFolder: config.dbClientFolder,
        }, 600000);

        const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
        await this.inspectraDb.updateSession(config.sessionId, { restoredDbName });
        dbSummary = await dbAnalyzer.analyze();

        if (config.machineIds && config.machineIds.length > 0) {
          const targetMachines = dbSummary.machines.filter(m => config.machineIds!.includes(m.id));
          dbSummary = { ...dbSummary, machines: targetMachines, totalMachines: targetMachines.length };
          onLog(`[ORCHESTRATOR] Filtered to ${targetMachines.length} target machines.`);
        }
      }

      // ── STEP 3.5: Seed incoming data via HTTP → VM incoming-service ───────
      //
      // Flow:
      //   1. Clear incoming_service.incoming_data on VM MongoDB.
      //   2. Read push config from incoming_service.incoming_config
      //      (ids referenced by machine.incoming_data_config).
      //   3. Read incoming-service port from machine.machine_services_config.
      //   4. Load test data from control-machine disk: test-data/incoming-test.json
      //      using key = clientName.toLowerCase() + "_incoming".
      //   5. Build payload per record using mapping rules (Direct/GUID/Static/Now).
      //   6. POST each AWB to http://{vmIp}:{port}{endpoint}.
      //   7. First successfully pushed AWB becomes validAwb for SUCC + DUPR tests.

      let pushedAwbs: string[] = [];

      if (dbSummary && dbSummary.machines.length > 0) {
        onLog(`[SEEDER] Starting incoming data seed for client: ${config.clientName}`);
        onProgress?.('Seeding Incoming Data', 35);

        // Use the first target machine (or the selected one if machineIds provided)
        const seedMachine = dbSummary.machines[0];

        try {
          const seeder = new IncomingDataSeeder(this.testDbUri, this.vmIp, this.workspacePath);
          const seedResult = await seeder.seed(config.clientName, seedMachine.id, onLog);
          pushedAwbs = seedResult.pushed;

          if (pushedAwbs.length === 0) {
            onLog(`[WARNING] No AWBs were pushed to incoming-service — SUCC/DUPR tests will fallback to DB lookup`);
          } else {
            onLog(`[SEEDER] ✅ ${pushedAwbs.length} AWBs seeded. validAwb for tests: ${seedResult.validAwb}`);
          }
        } catch (e: any) {
          onLog(`[WARNING] Incoming data seeding failed: ${e.message} — test builder will fallback to DB lookup`);
        }
      } else {
        onLog(`[WARNING] No machines found — skipping incoming data seed`);
      }

      // ── STEP 4: LLM Analysis ─────────────────────────────────────────────
      onLog(`[AI] Analyzing code + database...`);
      onProgress?.('AI Analysis', 50);

      if (!dbSummary) {
        dbSummary = {
          dbName: restoredDbName, totalMachines: 1, activeMachines: 1,
          machines: [{ id: 'virtual-01', name: config.machineDescriptions || 'Default Machine', machine_key: 'MA01', type: 'sorter', location: 'Remote', status: true, configCount: 1, configs: [] }],
          totalConfigs: 0, clients: [config.clientName], configTypes: {}
        };
      }

      await this.inspectraDb.updateSession(config.sessionId, { machineCount: dbSummary.totalMachines });

      const [codeInsights, dbInsights, scalingData] = await Promise.all([
        this.llama.analyzeCodebase(codeSummary),
        this.llama.analyzeDatabase(dbSummary),
        this.llama.analyzeConfig(dbSummary)
      ]);

      await this.inspectraDb.saveAnalysis({
        sessionId: config.sessionId, codeInsights, dbInsights,
        scalingPlan: scalingData.scaling,
        recommendations: scalingData.scaling.map((s: any) => `${s.service}: ${s.reason}`),
        generatedAt: new Date()
      });

      // ── STEP 5: Generate test cases ──────────────────────────────────────
      onLog(`[AI] Generating test cases...`);
      onProgress?.('Generating Tests', 70);

      // Pass pushedAwbs so TestCaseBuilder uses them for SUCC/DUPR
      // instead of doing a fresh DB lookup (which would find the same
      // AWBs we just pushed, but this is explicit and avoids latency).
      const testCases = await this.generateSessionTestCases(
        config.sessionId, codeSummary, restoredDbName, dbSummary, pushedAwbs
      );
      onLog(`[ORCHESTRATOR] Generated ${testCases.length} test cases.`);

      await this.inspectraDb.updateSession(config.sessionId, { status: 'COMPLETED' });
      onProgress?.('Ready', 100);

    } catch (err: any) {
      onLog(`[ERROR] Run failed: ${err.message}`);
      await this.inspectraDb.updateSession(config.sessionId, { status: 'FAILED', completedAt: new Date() });
      throw err;
    }

    return { status: 'PROVISIONED', sessionId: config.sessionId };
  }

  // ── generateSessionTestCases ───────────────────────────────────────────────
  //
  // pushedAwbs: AWBs successfully seeded via IncomingDataSeeder.
  //   If provided and non-empty, TestCaseBuilder skips its DB lookup
  //   and uses pushedAwbs[0] as the validAwb for SUCC + DUPR scenarios.
  //   DNFR and IBAR cases are unaffected.

  async generateSessionTestCases(
    sessionId: string,
    providedCodeSummary: CodeSummary,
    restoredDbName: string,
    providedSummary?: DbSummary,
    pushedAwbs: string[] = []          // ← NEW param
  ): Promise<any[]> {
    let dbSummary = providedSummary;
    if (!dbSummary) {
      const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
      dbSummary = await dbAnalyzer.analyze();
    }
    const builder = new TestCaseBuilder(this.testDbUri, restoredDbName);

    // Pass pushedAwbs to builder — it will use them for SUCC/DUPR
    const testCases = await builder.buildWithLlm(dbSummary, providedCodeSummary, pushedAwbs);

    const casesWithMeta = testCases.map((tc, i) => ({
      ...tc,
      testId: tc.testId || `TC-${String(i + 1).padStart(3, '0')}`,
      sessionId, generatedBy: 'llm' as const, createdAt: new Date()
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

    let testCases = await this.inspectraDb.getTestCases(sessionId);

    const dbName = session.restoredDbName || 'inspectra_csnd';
    const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
    const dbSummary = await dbAnalyzer.analyze();

    const sessionMachineIds = session.machineIds || [];
    const targetMachines = sessionMachineIds.length > 0
      ? dbSummary.machines.filter(m => sessionMachineIds.includes(m.id))
      : dbSummary.machines;

    const filteredSummary = { ...dbSummary, machines: targetMachines, totalMachines: targetMachines.length };
    const selectedMachine = targetMachines.find(m => m.type?.toLowerCase() === 'astro') || targetMachines[0] || dbSummary.machines[0];

    await this.executePhase(sessionId, '/data/NIDOWORKZ/CSND', dbName, testCases, onLog, onProgress, filteredSummary, selectedMachine?.id);
  }

  getHealth(): ServiceInfo[] { return this.services; }

  async runE2ETests(sessionId: string, onLog: (msg: string) => void, onProgress?: (step: string, percent: number) => void): Promise<E2EReport> {
    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    const dbName = session.restoredDbName || 'inspectra_csnd';
    onLog(`[E2E] Initializing E2E test runner for session: ${sessionId}`);
    onProgress?.('Starting E2E Tests', 10);
    const runner = new E2ETestRunner({
      tcpHost: '127.0.0.1', tcpPort: 3000, mongoUri: this.testDbUri,
      sessionDbName: dbName, machineKey: 'MA01',
    });
    runner.on('log', (msg: string) => onLog(msg));
    onProgress?.('Running Tests', 30);
    const report = await runner.run(sessionId);
    onProgress?.('Saving Results', 80);
    for (const result of report.results) {
      await this.inspectraDb.saveResult({
        sessionId, testId: result.testId, barcode: result.responses.join(' | '),
        service: 'e2e-pipeline', status: result.status as 'PASS' | 'FAIL' | 'ERROR',
        reason: result.reason,
        trace: { category: result.category, responses: result.responses, dbValidation: result.dbValidation, durationMs: result.durationMs },
        executedAt: result.timestamp,
      });
    }
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
    const session = await this.inspectraDb.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    try {
      await this.inspectraDb.updateSession(sessionId, { status: 'RUNNING', startedAt: new Date() });
      const dbName = session.restoredDbName || 'inspectra_csnd';

      // Re-restore DB from GitHub repo
      if (session.dbRepoUrl && session.dbClientFolder) {
        onLog(`[ORCHESTRATOR] Re-restoring DB from GitHub repo on VM...`);
        const token = process.env.GITHUB_TOKEN;
        const authedRepoUrl = token && !session.dbRepoUrl.includes('@')
          ? session.dbRepoUrl.replace('https://', `https://${token}@`)
          : session.dbRepoUrl;
        await emitToInfraWithAck('infra:restore-db', {
          repoUrl: authedRepoUrl,
          clientFolder: session.dbClientFolder,
        }, 600000);
      }

      const dbAnalyzer = new DbAnalyzer(this.testDbUri, dbName);
      const dbSummary = await dbAnalyzer.analyze();

      // ── Re-seed incoming data ──────────────────────────────────────────
      let pushedAwbs: string[] = [];

      if (dbSummary.machines.length > 0 && session.clientName) {
        onLog(`[SEEDER] Re-seeding incoming data for rerun...`);
        const seedMachine = dbSummary.machines[0];

        try {
          const seeder = new IncomingDataSeeder(this.testDbUri, this.vmIp, this.workspacePath);
          const seedResult = await seeder.seed(session.clientName, seedMachine.id, onLog);
          pushedAwbs = seedResult.pushed;
          onLog(`[SEEDER] ✅ Rerun seed complete: ${pushedAwbs.length} AWBs. validAwb: ${seedResult.validAwb}`);
          onLog(`Push Configurations are Working fine ========>${pushedAwbs}`)
        } catch (e: any) {
          onLog(`[WARNING] Rerun seed failed: ${e.message} — falling back to DB lookup`);
        }
      }

      let codeSummary: CodeSummary;
      try {
        const analyzeResult = await emitToInfraWithAck('infra:analyze-code', { bePath: '/data/NIDOWORKZ/CSND' }, 60000);
        codeSummary = analyzeResult.codeSummary;
      } catch (e: any) {
        onLog(`[WARNING] VM code analysis failed: ${e.message} — using fallback`);
        codeSummary = { totalServices: 0, services: [], sharedLibs: [], techStack: ['TypeScript', 'Node.js', 'Express', 'MongoDB'], framework: 'npm workspaces monorepo' };
      }

      // Pass pushedAwbs to test case generator
      const testCases = await this.generateSessionTestCases(sessionId, codeSummary, dbName, dbSummary, pushedAwbs);

      const selectedMachine = dbSummary.machines.find(m => (m as any).machine_key && m.name?.toLowerCase().includes('astro'))
        || dbSummary.machines.find(m => m.type?.toLowerCase() === 'astro')
        || dbSummary.machines[0];

      onLog(`[ORCHESTRATOR] Selected machine: ${selectedMachine?.name} | key: ${(selectedMachine as any)?.machine_key}`);
      await this.executePhase(sessionId, '/data/NIDOWORKZ/CSND', dbName, testCases, onLog, onProgress, dbSummary, selectedMachine?.id);

    } catch (err: any) {
      onLog(`[ERROR] Re-run failed: ${err.message}`);
      await this.inspectraDb.updateSession(sessionId, { status: 'FAILED', completedAt: new Date() });
      throw err;
    }
  }

  async analyzeDiscoveredMachines(dbRepoUrl: string, dbClientFolder: string) {
    const restoredDbName = 'inspectra_csnd';
    try {
      await emitToInfraWithAck('infra:restore-db', {
        repoUrl: dbRepoUrl,
        clientFolder: dbClientFolder,
      }, 600000);

      const dbAnalyzer = new DbAnalyzer(this.testDbUri, restoredDbName);
      const summary = await dbAnalyzer.analyze();
      return {
        totalMachines: summary.totalMachines,
        machines: summary.machines.map(m => ({ id: m.id, name: m.name }))
      };
    } catch (err) {
      console.error('DB Discovery failed:', err);
      throw err;
    }
  }

  private async cleanupSortingDatabase(onLog: (msg: string) => void) {
    const client = new MongoClient(this.testDbUri);
    try {
      await client.connect();
      const sortingdb = client.db('sorting_service');
      onLog(`[ORCHESTRATOR] Clearing primary_sortings...`);
      await sortingdb.collection('primary_sortings').deleteMany({});

      const incomingdb = client.db('incoming_service');
      onLog(`[ORCHESTRATOR] Updating incoming_config base URLs...`);
      await incomingdb.collection('incoming_config').updateMany(
        {},
        {
          $set: {
            "api_details.base_url": "https://nido.com",
            "api_details.authentication_details.base_url": "https://nido.com"
          }
        }
      );

      const uploaderdb = client.db('data_uploader_service');
      onLog(`[ORCHESTRATOR] Updating Data posting URL...`);
      await uploaderdb.collection('integration_config').updateMany({}, {
        $set: {
          "api_details.base_url": "https://nido.com",
          "api_details.authentication_details.base_url": "https://nido.com"
        }
      });

      const baggingdb = client.db('bagging');
      onLog(`[ORCHESTRATOR] Resetting active_bags...`);
      await baggingdb.collection('active_bags').updateMany({}, {
        $set: {
          items: [],
          rejected_items: [],
          delinked_items: [],
          "count_data.allocated": 0, "count_data.scanned": 0, "count_data.balance": 0, "count_data.free": 0, "count_data.occupancy": 0,
          "weight_data.allocated": 0, "weight_data.scanned": 0, "weight_data.balance": 0, "weight_data.free": 0, "weight_data.occupancy": 0,
          "volume_data.allocated": 0, "volume_data.scanned": 0, "volume_data.balance": 0, "volume_data.free": 0, "volume_data.occupancy": 0,
          "volume_weight_data.allocated": 0, "volume_weight_data.scanned": 0, "volume_weight_data.balance": 0, "volume_weight_data.free": 0, "volume_weight_data.occupancy": 0
        }
      });
      onLog(`[ORCHESTRATOR] Database cleanup complete.`);
    } finally {
      await client.close();
    }
  }

  private async executePhase(
    sessionId: string, bePath: string, dbName: string, testCases: any[],
    onLog: (msg: string) => void, onProgress?: (step: string, percent: number) => void,
    dbSummary?: DbSummary, selectedMachineId?: string
  ) {
    onProgress?.('Starting VM Services', 78);
    try {
      await this.cleanupSortingDatabase(onLog);
    } catch (e: any) {
      onLog?.(`[WARNING] Failed to cleanup DB before test run: ${e.message}`);
    }

    const selectedMachine = selectedMachineId
      ? dbSummary?.machines.find(m => m.id === selectedMachineId)
      : dbSummary?.machines[0];

    try {
      onLog?.(`[ORCHESTRATOR] Instructing VM to spawn microservices...`);
      await emitToInfraWithAck('infra:spawn-services', {
        sessionId, mongoUri: this.testDbUri, dbName,
        machineId: selectedMachine?.id || '',
        machineKey: (selectedMachine as any)?.machine_key || 'MA01',
      }, 900000);
      onLog?.(`[ORCHESTRATOR] VM services are up.`);
    } catch (e: any) {
      onLog?.(`[ERROR] VM service spawn failed: ${e.message} — aborting tests`);
      throw new Error(`Cannot run tests: VM services failed to spawn (${e.message})`);
    }

    onProgress?.('Running Tests', 85);
    const runner = new TestRunner(this.testDbUri, this.workspacePath);
    const results = await runner.runAll(
      sessionId, testCases,
      dbSummary || { dbName, totalMachines: 1, activeMachines: 1, machines: [], totalConfigs: 0, clients: [], configTypes: {} },
      onLog
    );

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    onLog?.(`[ORCHESTRATOR] ✅ Tests complete: ${passed} passed, ${failed} failed`);

    try {
      const runDir = path.join(this.workspacePath, 'runs', `run_${sessionId}`);
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      const resultsPath = path.join(runDir, 'test-results.json');
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8');
      onLog?.(`[ORCHESTRATOR] Test results saved to ${resultsPath}`);
    } catch (err: any) {
      onLog?.(`[ERROR] Failed to save test-results.json: ${err.message}`);
    }

    await this.inspectraDb.updateSession(sessionId, {
      status: failed === 0 ? 'COMPLETED' : 'FAILED',
      completedAt: new Date()
    });
    onProgress?.('Done', 100);
  }

  private async stopServices(sessionId: string, onLog?: (msg: string) => void) {
    onLog?.(`[ORCHESTRATOR] Stopping services for ${sessionId}`);
    const processes = this.runningProcesses.get(sessionId);
    if (processes) {
      for (const p of processes) {
        try {
          if (p.pid) await execAsync(`taskkill /F /T /PID ${p.pid}`);
          else p.kill();
        } catch (e) { try { p.kill(); } catch (k) { } }
      }
      this.runningProcesses.delete(sessionId);
    }
    for (const service of this.services) {
      try { await execAsync(`pm2 delete ${service.name}_${sessionId}`); service.status = 'DOWN'; } catch (e) { }
    }
  }
}