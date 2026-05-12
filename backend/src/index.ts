import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { AdvancedSimulator } from './backend-tests/platform/advanced-simulator';
import { LifecycleValidator } from './backend-tests/platform/lifecycle-validator';
import { PipelineSimulator, PipelineStage } from './backend-tests/pipeline-simulator';
import { Orchestrator } from './orchestrator';
import { UIValidator } from './frontend-tests/ui-validator';
import { InspectraDB } from './core/inspectra-db';
import { TestRunner } from './backend-tests/test-runner';
import { logger } from './core/logger';
let infraSocket: any = null; // dedicated slot for the VM infra-node socket

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
    testFilePath, machineIds
  } = req.body;

  const sessionId = `SES-${Date.now()}`;

  try {
    const result = await orchestrator.coordinateRun(
      { sessionId, clientName, machineDescriptions, beRepo, beBranch, feRepo, feBranch, codeDir, dbBackupPath, testFilePath, machineIds },
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

// ── Download JSON Report ───────────────────────────────────────────────────────
app.get('/api/sessions/:id/download/json', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await inspectraDb.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const analysis = await inspectraDb.getAnalysis(sessionId);
    const results = await inspectraDb.getResults(sessionId);
    const tr = new TestRunner(mongoUri, workspacePath);
    const report = await tr.assembleFinalReport(
      sessionId, 'infra-node-01',
      { beCommit: session.beCommit, feCommit: session.feCommit },
      { os: 'linux', memory: '16GB' }, { avg_latency_ms: 420 },
      { status: session.status }, [],
      analysis?.recommendations || [], results as any
    );

    const safeName = `Report_${sessionId}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.json"`);
    res.send(JSON.stringify(report, null, 2));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download CSV Report ────────────────────────────────────────────────────────
app.get('/api/sessions/:id/download/csv', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await inspectraDb.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const results = await inspectraDb.getResults(sessionId);

    const headers = [
      'Test ID', 'Service', 'Scenario', 'Barcode',
      'Expected Status', 'Actual Status', 'Passed?',
      'Rejection Code', 'Reason',
      'UI Found?', 'UI Status', 'UI Rejection', 'UI Validation',
      'Executed At'
    ];

    const rows = results.map(r => {
      const rec = r as any;
      const passed = rec.passed;
      const passedLabel = passed === true ? 'YES ✅' : passed === false ? 'NO ❌' : '';
      const uiFoundLabel = rec.uiFound === true ? 'YES' : rec.uiFound === false ? 'NO' : '';
      return [
        r.testId,
        r.service,
        rec.scenario || '',
        r.barcode,
        rec.expectedStatus || '',
        r.status,
        passedLabel,
        rec.rejectionCode || '',
        `"${(r.reason || '').replace(/"/g, '""')}"`,
        uiFoundLabel,
        rec.uiDisplayedStatus || '',
        rec.uiDisplayedRejection || '',
        rec.uiStatus || '',
        new Date(r.executedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const clientName = (session.clientName || 'report').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const safeName = `Results_${clientName}_${sessionId}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
    res.send('\uFEFF' + csvContent); // BOM for Excel compatibility
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

  socket.on('infra:register', (vmInfo) => {
    infraSocket = socket; // ← store ONLY the infra-node socket here
    const vmIp = socket.handshake.address.replace('::ffff:', '');
    orchestrator.setVmIp(vmIp);
    logger.info(`[INFRA] VM Registered: ${vmInfo.hostname} (${vmInfo.os}) from IP ${vmIp}`, 'INFRA');
    io.emit('infra:vm-connected', { hostname: vmInfo.hostname, os: vmInfo.os });
  });

  socket.on('infra:status', (status) => {
    logger.info(`[INFRA] Nginx: ${status.nginx}, PHP: ${status.php}`, 'INFRA');
    io.emit('infra:vm-status', status); // forward to frontend
  });

  socket.on('infra:service-status', (data) => {
    logger.info(`[INFRA] Service ${data.serviceName} is ${data.status}`, 'INFRA');
  });

  // Relay setup progress from infra-node → frontend
  socket.on('setup:progress', (data) => {
    io.emit('setup:progress', data);
  });

  // Relay log lines from infra-node → frontend terminal
  socket.on('simulator:packet', (data) => {
    io.emit('simulator:packet', data);
  });

  socket.on('infra:log', (data) => {
    io.emit('simulator:packet', { data: data.message, timestamp: new Date().toISOString() });
  });

  socket.on('disconnect', () => {
    if (infraSocket?.id === socket.id) {
      infraSocket = null;
      logger.info('[INFRA] VM infra-node disconnected', 'INFRA');
      io.emit('infra:vm-disconnected', {});
    }
    logger.info(`Client disconnected: ${socket.id}`, 'SOCKET');
  });
});

export const simulateOnInfra = async (data: any): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!infraSocket) {
      return reject(new Error('No infra-node connected. Is the VM agent running?'));
    }
    infraSocket.timeout(20000).emit('infra:simulate-cycle', data, (err: any, response: any) => {
      if (err) return reject(new Error('Simulation timed out on infra-node'));
      if (!response?.success) return reject(new Error(response?.error || 'Remote simulation failed'));
      resolve(response.result);
    });
  });
};

export const emitToInfra = (event: string, data: any): void => {
  if (!infraSocket) {
    logger.warn('[ORCHESTRATOR] No infra-node connected — cannot emit: ' + event, 'INFRA');
    return;
  }
  infraSocket.emit(event, data);
};
export const emitToInfraWithAck = (event: string, data: any, timeoutMs = 300000): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!infraSocket) {
      return reject(new Error('No infra-node connected. Is the VM agent running?'));
    }
    infraSocket.timeout(timeoutMs).emit(event, data, (err: any, response: any) => {
      if (err) return reject(new Error(`Infra ack timeout for event: ${event}`));
      if (!response?.success) return reject(new Error(response?.error || `Infra returned failure for: ${event}`));
      resolve(response);
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
