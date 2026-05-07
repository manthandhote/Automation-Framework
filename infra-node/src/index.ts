import { io, Socket } from 'socket.io-client';
import os from 'os';
import { Installer } from './installer';
import { ProcessManager } from './process-manager';
import { MachineSimulator } from './simulator';
import { logger } from './logger';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const socket: Socket = io(ORCHESTRATOR_URL);
const processManager = new ProcessManager();

logger.info(`Connecting to AUTOMYRIX at ${ORCHESTRATOR_URL}...`);

socket.on('connect', async () => {
  logger.info('Connected to AUTOMYRIX Orchestrator.');
  
  // Phase 2: Infra Discovery - Send VM info
  const vmInfo = {
    hostname: os.hostname(),
    os: os.platform(),
    release: os.release(),
    cpuCount: os.cpus().length,
    totalMem: Math.round(os.totalmem() / 1024 / 1024),
    freeMem: Math.round(os.freemem() / 1024 / 1024)
  };
  
  socket.emit('infra:register', vmInfo);
  
  // Verify Nginx / PHP
  const nginxStatus = await Installer.checkAndInstallNginx();
  const phpStatus = await Installer.checkAndInstallPhp();
  
  socket.emit('infra:status', {
    nginx: nginxStatus ? 'running' : 'not running',
    php: phpStatus ? 'installed' : 'not installed',
    status: (nginxStatus && phpStatus) ? 'PASS' : 'FAIL'
  });
});

// Phase 3: Service Orchestration via WebSocket
socket.on('infra:start-service', (data: { serviceName: string, servicePath: string, port: number }) => {
  const success = processManager.startService(data.serviceName, data.servicePath, data.port);
  socket.emit('infra:service-status', { serviceName: data.serviceName, status: success ? 'UP' : 'FAILED' });
});

socket.on('infra:stop-service', (data: { serviceName: string }) => {
  const success = processManager.stopService(data.serviceName);
  socket.emit('infra:service-status', { serviceName: data.serviceName, status: success ? 'DOWN' : 'FAILED' });
});

socket.on('infra:simulate-cycle', async (data: any, callback: Function) => {
  logger.info(`Simulating cycle for ${data.barcode} on ${data.machineKey} (${data.protocol})`);
  try {
    const simulator = new MachineSimulator(data.transport, data.options);
    
    // Stream packets back to orchestrator
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

socket.on('disconnect', () => {
  logger.info('Disconnected from Orchestrator.');
});
