import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { AdvancedSimulator } from './platform/advanced-simulator';
import { LifecycleValidator } from './platform/lifecycle-validator';
import { PipelineSimulator, PipelineStage } from './pipeline-simulator';
import { Orchestrator } from './orchestrator';
import { UIValidator } from './ui-validator';
import { InspectraDB } from './inspectra-db';
import { TestRunner } from './test-runner';
import { logger } from './logger';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4200;
const workspacePath = process.env.WORKSPACE_PATH || path.resolve(__dirname, '../..');
logger.info(`Resolved workspace: ${workspacePath}`, 'STARTUP');
const mongoUri = process.env.INSPECTRA_DB_URI || 'mongodb://127.0.0.1:27017';

// ─── File Upload Config ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(workspacePath, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

const INSPECTRA_DB_NAME = process.env.INSPECTRA_DB_NAME || 'inspectra_meta';
InspectraDB.init(mongoUri, INSPECTRA_DB_NAME);

const orchestrator = new Orchestrator(workspacePath);
const validator = new LifecycleValidator(mongoUri);
const simulator = new AdvancedSimulator();
const pipelineSimulator = new PipelineSimulator();
const uiValidator = new UIValidator();
const inspectraDb = InspectraDB.getInstance();

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap() {
  await inspectraDb.connect();
  await orchestrator.init();
  logger.info('Automyrix DB connected.', 'BOOTSTRAP');
}

bootstrap().catch(err => logger.error('Bootstrap failed', 'BOOTSTRAP', err));

// ══════════════════════════════════════════════════════════════════════════════
//  Health
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', services: orchestrator.getHealth() });
});

// ══════════════════════════════════════════════════════════════════════════════
//  File Upload (DB backup + optional test file)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/upload', upload.fields([
  { name: 'dbFile', maxCount: 1 },
  { name: 'testFile', maxCount: 1 }
]), (req, res) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  res.json({
    status: 'UPLOADED',
    paths: {
      dbFile: files['dbFile']?.[0]?.path,
      testFile: files['testFile']?.[0]?.path
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Enterprise Setup — main provisioning endpoint
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/setup', async (req, res) => {
  const {
    clientName,
    machineDescriptions,
    beRepo, beBranch,
    feRepo, feBranch,
    codeDir,
    dbBackupPath,
    testFilePath
  } = req.body;

  const sessionId = `SES-${Date.now()}`;

  try {
    const result = await orchestrator.coordinateRun(
      { sessionId, clientName, machineDescriptions, beRepo, beBranch, feRepo, feBranch, codeDir, dbBackupPath, testFilePath },
      (msg) => {
        console.log(msg); // 🖥️ Print to terminal
        io.emit('simulator:packet', { data: msg, timestamp: new Date().toISOString() });
      },
      (step, percent) => io.emit('setup:progress', { step, percent })
    );
    res.json({ status: 'SUCCESS', sessionId, result });
  } catch (error: any) {
    res.status(500).json({ status: 'ERROR', sessionId, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Session History Endpoints
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await inspectraDb.getSessions();
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await inspectraDb.getSession(req.params.id);
    const analysis = await inspectraDb.getAnalysis(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session, analysis });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id/test-cases', async (req, res) => {
  try {
    const cases = await inspectraDb.getTestCases(req.params.id);
    res.json({ testCases: cases });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/rerun', async (req, res) => {
  const { sessionId } = req.params;
  try {
    orchestrator.rerunSession(sessionId, (msg) => {
      console.log(msg); // 🖥️ Print to terminal
      io.emit('simulator:packet', { data: msg, timestamp: new Date().toISOString() });
    }, (step, percent) => {
      io.emit('setup:progress', { step, percent });
    }).catch(err => {
      console.error(err);
      io.emit('simulator:packet', { data: `❌ RERUN FATAL ERROR: ${err.message}`, timestamp: new Date().toISOString() });
    });

    res.json({ status: 'RERUN_STARTED', sessionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/start-tests', async (req, res) => {
  const { sessionId } = req.params;
  try {
    orchestrator.runFromReviewedCases(sessionId, (msg) => {
      console.log(msg); // 🖥️ Print to terminal
      io.emit('simulator:packet', { data: msg, timestamp: new Date().toISOString() });
    }, (step, percent) => {
      io.emit('setup:progress', { step, percent });
    }).catch(err => {
      console.error(err);
      io.emit('simulator:packet', { data: `❌ EXECUTION FATAL ERROR: ${err.message}`, timestamp: new Date().toISOString() });
    });

    res.json({ status: 'EXECUTION_STARTED', sessionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id/results', async (req, res) => {
  try {
    const results = await inspectraDb.getResults(req.params.id);
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  E2E Test Execution
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/sessions/:sessionId/run-e2e', async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Fire-and-forget: return immediately, stream progress via socket
    orchestrator.runE2ETests(sessionId, (msg) => {
      console.log(msg);
      io.emit('simulator:packet', { data: msg, timestamp: new Date().toISOString() });
    }, (step, percent) => {
      io.emit('setup:progress', { step, percent });
    }).then(report => {
      io.emit('e2e:complete', report);
    }).catch(err => {
      console.error(err);
      io.emit('simulator:packet', { data: `❌ E2E TEST ERROR: ${err.message}`, timestamp: new Date().toISOString() });
    });

    res.json({ status: 'E2E_STARTED', sessionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


//  Pipeline Pulse
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/pipeline/pulse', async (req, res) => {
  const { stage, barcode, customPayload } = req.body;
  const bcode = barcode || `AWB_PULSE_${Date.now()}`;

  try {
    let result: any;
    switch (stage as PipelineStage) {
      case 'incoming':
        result = await pipelineSimulator.injectToIncoming(customPayload || { barcode: bcode });
        break;
      case 'mapper':
        result = await pipelineSimulator.injectToMapper([customPayload || pipelineSimulator.generateResolvedPayload(bcode)]);
        break;
      case 'posting':
        result = await pipelineSimulator.injectToPosting([customPayload || pipelineSimulator.generateMappedPackage(bcode)]);
        break;
      default:
        return res.status(400).json({ status: 'ERROR', message: 'Invalid stage' });
    }
    res.json({ status: 'PULSED', stage, bcode, response: result.data });
  } catch (error: any) {
    res.status(500).json({ status: 'ERROR', message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Simulate + Validate + Report
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/simulate', async (req, res) => {
  const { protocol = 'capella' } = req.body;
  const barcode = `AWB${Math.floor(Math.random() * 1000000000)}`;
  const result = await simulator.runFullCycle(barcode, 'MA01', protocol as any);
  res.json({ status: 'SIMULATING', protocol, barcode, result });
});

app.get('/api/validate/:barcode', async (req, res) => {
  const { barcode } = req.params;
  const runId = (req.query.runId as string) || 'legacy';
  const startTime = Date.now();
  const result = await validator.getParcelStatus(barcode);
  const uiResult = await uiValidator.validateParcelDisplay('http://localhost:8080', barcode, runId, 'latest');
  res.json({ ...result, latency_ms: Date.now() - startTime, uiResult });
});

app.get('/api/sessions/:id/report', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await inspectraDb.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    
    const analysis = await inspectraDb.getAnalysis(sessionId);
    const results = await inspectraDb.getResults(sessionId);
    
    const tr = new TestRunner(mongoUri, workspacePath);
    
    const report = await tr.assembleFinalReport(
      sessionId,
      'infra-node-01',
      { beCommit: session.beCommit, feCommit: session.feCommit },
      { os: 'linux', memory: '16GB' },
      { avg_latency_ms: 420 },
      { status: session.status },
      [], // alerts
      analysis?.recommendations || [],
      results as any
    );
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Git Branches
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/git/branches', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const branches = await orchestrator.fetchRemoteBranches(url as string);
    res.json({ branches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze-db', async (req, res) => {
  const { dbPath } = req.body;
  if (!dbPath) return res.status(400).json({ error: 'dbPath is required' });
  try {
    const data = await orchestrator.analyzeDiscoveredMachines(dbPath);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Real-time ────────────────────────────────────────────────────────────────
simulator.on('packet', (data) => {
  io.emit('simulator:packet', { data, timestamp: new Date() });
});

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`, 'SOCKET');
  socket.emit('system:init', { health: orchestrator.getHealth() });

  // ── Phase 2: Infra Discovery ────────────────────────────────────────────────
  socket.on('infra:register', (vmInfo) => {
    logger.info(`[INFRA] VM Registered: ${vmInfo.hostname} (${vmInfo.os})`, 'INFRA');
  });

  socket.on('infra:status', (status) => {
    logger.info(`[INFRA] Nginx: ${status.nginx}, PHP: ${status.php}`, 'INFRA');
  });

  socket.on('infra:service-status', (data) => {
    logger.info(`[INFRA] Service ${data.serviceName} is ${data.status}`, 'INFRA');
  });
  
  socket.on('simulator:packet', (data) => {
    io.emit('simulator:packet', data); // relay to frontend
  });
});

export const simulateOnInfra = async (data: any): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (io.sockets.sockets.size === 0) {
      return reject(new Error("No infra-node connected to orchestrator"));
    }
    const [firstSocket] = io.sockets.sockets.values();
    firstSocket.timeout(20000).emit('infra:simulate-cycle', data, (err: any, response: any) => {
      if (err) return reject(new Error("Simulation timed out on infra-node"));
      if (!response.success) return reject(new Error(response.error || "Remote simulation failed"));
      resolve(response.result);
    });
  });
};

// Phase 12 Real-Time Streaming Exposer
export const streamEvent = (event: 'STEP_RESULT' | 'ALERT' | 'PERFORMANCE_UPDATE', data: any) => {
  io.emit(event, { ...data, timestamp: new Date().toISOString() });
};

const BANNER = `
   █████╗ ██╗   ██╗████████╗ ██████╗ ███╗   ███╗██╗   ██╗██████╗ ██╗██╗  ██╗
  ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗████╗ ████║╚██╗ ██╔╝██╔══██╗██║╚██╗██╔╝
  ███████║██║   ██║   ██║   ██║   ██║██╔████╔██║ ╚████╔╝ ██████╔╝██║ ╚███╔╝ 
  ██╔══██║██║   ██║   ██║   ██║   ██║██║╚██╔╝██║  ╚██╔╝  ██╔══██╗██║ ██╔██╗ 
  ██║  ██║╚██████╔╝   ██║   ╚██████╔╝██║ ╚═╝ ██║   ██║   ██║  ██║██║██╔╝ ██╗
  ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝     ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝
                     🚀  A U T O M Y R I X   C O N T R O L  🚀
                            ${new Date().toISOString()}
`;

httpServer.listen(PORT, () => {
  logger.banner(BANNER);
  logger.primary(`Automyrix Control Engine running on port ${PORT}`, 'STARTUP');
});
