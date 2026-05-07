import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from './logger';

export class ProcessManager {
  private processes: Map<string, ChildProcess> = new Map();

  startService(serviceName: string, servicePath: string, port: number) {
    if (this.processes.has(serviceName)) {
      logger.info(`Service ${serviceName} is already running.`);
      return;
    }

    logger.info(`Starting ${serviceName} on port ${port}...`);
    
    const env = { ...process.env, PORT: port.toString() };
    const proc = spawn('npm', ['start'], {
      cwd: servicePath,
      env,
      shell: true
    });

    proc.stdout?.on('data', (data) => logger.info(`[${serviceName}] ${data.toString().trim()}`));
    proc.stderr?.on('data', (data) => logger.error(`[${serviceName} ERR] ${data.toString().trim()}`));

    this.processes.set(serviceName, proc);
    return true;
  }

  stopService(serviceName: string) {
    const proc = this.processes.get(serviceName);
    if (proc) {
      logger.info(`Stopping ${serviceName}...`);
      proc.kill();
      this.processes.delete(serviceName);
      return true;
    }
    return false;
  }

  getRunningServices() {
    return Array.from(this.processes.keys());
  }
}
