import { exec, spawn, ChildProcess } from 'child_process';
import util from 'util';
import fs from 'fs';
import { logger } from './logger';

const execAsync = util.promisify(exec);

// ─── CRC16 Modbus ─────────────────────────────────────────────────────────────
// Polynomial: 0xA001 (reversed 0x8005)
// Initial value: 0xFFFF
// Used for both request validation and response generation.

function crc16(buffer: Buffer): number {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// ─── RTU Frame builder ────────────────────────────────────────────────────────
//
// Builds a Modbus RTU response for Function Code 03 (Read Holding Registers).
//
// Frame: [SlaveID][FC=03][ByteCount][Reg0Hi][Reg0Lo]...[CRCLo][CRCHi]
//
// registers: array of 16-bit values (each becomes 2 bytes, big-endian)

export function buildRTUResponse(slaveId: number, registers: number[]): Buffer {
  const byteCount = registers.length * 2;
  const frame = Buffer.alloc(3 + byteCount + 2);

  frame[0] = slaveId;
  frame[1] = 0x03;           // FC: Read Holding Registers
  frame[2] = byteCount;

  for (let i = 0; i < registers.length; i++) {
    const val = registers[i] & 0xFFFF;
    frame[3 + i * 2] = (val >> 8) & 0xFF;  // High byte
    frame[3 + i * 2 + 1] = val & 0xFF;      // Low byte
  }

  const crc = crc16(frame.subarray(0, 3 + byteCount));
  frame[3 + byteCount] = crc & 0xFF;        // CRC Low byte first (Modbus convention)
  frame[3 + byteCount + 1] = (crc >> 8) & 0xFF;

  return frame;
}

// ─── Parse RTU request ────────────────────────────────────────────────────────

interface RTURequest {
  slaveId: number;
  functionCode: number;
  startAddress: number;
  registerCount: number;
}

export function parseRTURequest(data: Buffer): RTURequest | null {
  if (data.length < 8) return null;  // Minimum RTU frame = 8 bytes
  return {
    slaveId: data[0],
    functionCode: data[1],
    startAddress: (data[2] << 8) | data[3],
    registerCount: (data[4] << 8) | data[5],
  };
}

// ─── Socat pair ───────────────────────────────────────────────────────────────

export interface SocatPair {
  appPort: string;    // The port the app opens (configured in machine_services_config)
  simPort: string;    // The port the simulator writes to
  process: ChildProcess;
}

/**
 * Spawns a socat virtual serial pair.
 * Returns { appPort, simPort } where appPort goes into machine config
 * and simPort is used by the RTU slave.
 *
 * socat output format (on stderr):
 *   2026-05-19 ... N PTY is /dev/pts/X
 *   2026-05-19 ... N PTY is /dev/pts/Y
 */
export async function spawnSocatPair(): Promise<SocatPair> {
  return new Promise((resolve, reject) => {
    const proc = spawn('socat', [
      '-d', '-d',
      'pty,raw,echo=0',
      'pty,raw,echo=0'
    ]);

    const ports: string[] = [];
    let resolved = false;

    const onData = (data: Buffer) => {
      const text = data.toString();
      const matches = text.match(/PTY is (\/dev\/pts\/\d+)/g);
      if (matches) {
        for (const m of matches) {
          const port = m.replace('PTY is ', '');
          if (!ports.includes(port)) ports.push(port);
        }
      }

      if (ports.length >= 2 && !resolved) {
        resolved = true;
        resolve({
          appPort: ports[0],
          simPort: ports[1],
          process: proc,
        });
      }
    };

    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);

    proc.on('error', (err) => {
      if (!resolved) reject(new Error(`socat failed: ${err.message}`));
    });

    // Timeout if ports don't appear
    setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('socat did not produce ports within 5s'));
      }
    }, 5000);
  });
}

// ─── RTU Slave ────────────────────────────────────────────────────────────────

export interface RTUSlaveConfig {
  simPort: string;          // /dev/pts/Y — simulator writes here
  slaveId: number;          // Modbus slave ID this slave responds to
  getRegisters: () => number[];  // Dynamic register values
  onLog?: (msg: string) => void;
}

export class RTUSlave {
  private fd: number | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private running = false;
  private intervalHandle: NodeJS.Timer | null = null;

  constructor(private config: RTUSlaveConfig) {}

  async start(): Promise<void> {
    const { simPort, slaveId, getRegisters, onLog } = this.config;

    // Open the serial port using low-level fd (avoids serialport library dependency)
    try {
      // Set serial port parameters first
      await execAsync(`stty -F ${simPort} 9600 raw -echo cs8 -cstopb -parenb`);
    } catch (e) {
      // May fail on virtual pts — that's OK, virtual ports ignore baud settings
    }

    this.fd = fs.openSync(simPort, 'r+');
    this.running = true;
    onLog?.(`[RTU-SLAVE] Slave ${slaveId} listening on ${simPort}`);

    // Poll for incoming data using a readable stream approach
    const readStream = fs.createReadStream(simPort, { fd: this.fd, autoClose: false });

    readStream.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      // RTU request frame is always 8 bytes for FC=03
      while (this.buffer.length >= 8) {
        const req = parseRTURequest(this.buffer);
        if (req && req.slaveId === slaveId && req.functionCode === 0x03) {
          const registers = getRegisters();
          const response = buildRTUResponse(slaveId, registers);

          onLog?.(`[RTU-SLAVE] Slave ${slaveId} → request addr=${req.startAddress} count=${req.registerCount} → responding with ${registers.length} registers`);

          try {
            fs.writeSync(this.fd!, response);
          } catch (e: any) {
            onLog?.(`[RTU-SLAVE] Write error: ${e.message}`);
          }

          // Consume the processed frame
          this.buffer = this.buffer.subarray(8);
        } else {
          // Not our slave or unknown frame — discard one byte and retry
          this.buffer = this.buffer.subarray(1);
        }
      }
    });

    readStream.on('error', (err) => {
      if (this.running) {
        onLog?.(`[RTU-SLAVE] Stream error on ${simPort}: ${err.message}`);
      }
    });
  }

  stop(): void {
    this.running = false;
    if (this.intervalHandle) clearInterval(this.intervalHandle as any);
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (_) {}
      this.fd = null;
    }
  }
}

// ─── Managed set of socat pairs + RTU slaves ──────────────────────────────────

export interface ModbusDevice {
  connectionId: number;
  slaveId: number;
  registerAddress: number;
  portName: string;          // Original port from machine config
  socatPair?: SocatPair;
  rtuSlave?: RTUSlave;
  assignedAppPort?: string;  // New virtual port for app
  assignedSimPort?: string;  // New virtual port for simulator
}

export class ModbusSimulator {
  private devices: ModbusDevice[] = [];
  private dimensionRegisters: number[] = [4083, 4249, 7836, 7273, 0, 0, 0, 0, 0, 0];
  private weightRegisters: number[] = [0, 535, 1, 0, 0, 0, 0, 0, 0, 1];

  constructor(private onLog: (msg: string) => void) {}

  // ── Set custom register values (for different test scenarios) ──────────────
  setDimensionRegisters(registers: number[]) { this.dimensionRegisters = registers; }
  setWeightRegisters(registers: number[]) { this.weightRegisters = registers; }

  // ── Get register values that produce weight_kg ─────────────────────────────
  // Weight formula (from logs): registers[1] = weight_kg * 100
  buildWeightRegisters(weightKg: number): number[] {
    const regs = [...this.weightRegisters];
    regs[1] = Math.round(weightKg * 100);
    return regs;
  }

  // ── Parse machine config and set up socat + RTU slaves ─────────────────────
  // Returns mapping: connectionId → new virtual port (for updating machine config)
  async setup(
    connectionPools: any[],
    devices: any[],
  ): Promise<Record<number, string>> {
    const portMap: Record<number, string> = {};

    for (const pool of connectionPools) {
      if (pool.type !== 'Modbus') continue;

      this.onLog(`[MODBUS-SIM] Setting up socat for connection_id=${pool.connection_id} (slave_id=${pool.slave_id})`);

      try {
        // Find the device using this connection to determine data type
        const device = devices.find((d: any) => d.connection_id === pool.connection_id);
        const dataType: string = String(device?.data || '').toLowerCase();

        // Spawn socat pair
        const pair = await spawnSocatPair();
        this.onLog(`[MODBUS-SIM] socat pair: app=${pair.appPort} sim=${pair.simPort}`);

        // Choose register source based on device data type
        const getRegisters = dataType === 'dimension'
        ? () => [...this.dimensionRegisters]
        : dataType === 'weight'
        ? () => [...this.weightRegisters]
        : () => {
          this.onLog(`[MODBUS-SIM] Unknown device data type for connection_id=${pool.connection_id}; returning zero registers`);
          return Array(10).fill(0);
        };

        // Start RTU slave on sim port
        const slave = new RTUSlave({
          simPort: pair.simPort,
          slaveId: pool.slave_id,
          getRegisters,
          onLog: this.onLog,
        });
        await slave.start();

        portMap[pool.connection_id] = pair.appPort;

        this.devices.push({
          connectionId: pool.connection_id,
          slaveId: pool.slave_id,
          registerAddress: pool.register_address || 0,
          portName: pool.port_name,
          socatPair: pair,
          rtuSlave: slave,
          assignedAppPort: pair.appPort,
          assignedSimPort: pair.simPort,
        });

        this.onLog(`[MODBUS-SIM] ✅ RTU slave ${pool.slave_id} ready on ${pair.simPort} (app uses ${pair.appPort})`);

      } catch (e: any) {
        this.onLog(`[MODBUS-SIM] ❌ Failed to set up connection_id=${pool.connection_id}: ${e.message}`);
      }
    }

    return portMap;
  }

  // ── Tear down all socat processes and RTU slaves ───────────────────────────
  teardown(): void {
    for (const dev of this.devices) {
      dev.rtuSlave?.stop();
      try { dev.socatPair?.process.kill(); } catch (_) {}
    }
    this.devices = [];
    this.onLog(`[MODBUS-SIM] All socat pairs and RTU slaves stopped`);
  }

  getDevices(): ModbusDevice[] { return this.devices; }
}
