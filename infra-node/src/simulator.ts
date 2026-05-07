import { EventEmitter } from 'events';
import * as net from 'net';
import { SerialPort } from 'serialport';
import ModbusRTU from 'modbus-serial';

export type ProtocolType = 'capella' | 'astro' | 'generic';
export type EdgeProfile = 'NORMAL' | 'MISSING_PD' | 'DUPLICATE_PB' | 'DELAYED_PACKET' | 'CORRUPT_DATA';

export interface SimulationStep {
  type: 'PB' | 'PD' | 'PW' | 'PC';
  data: string;
}

export class ProtocolBuilder {
  static buildPB(machineKey: string, trackingId: string, barcode: string, type: ProtocolType = 'capella'): string {
    return `${machineKey},${trackingId},PB,FL01,A,1001,${barcode}`;
  }

  static buildPD(
    machineKey: string, 
    trackingId: string, 
    dims: {l: number, b: number, h: number},
    weight: number = 0.12,
    type: ProtocolType = 'capella'
  ): string {
    const vol = dims.l * dims.b * dims.h;
    const realVol = Math.floor(vol * 0.665);
    return `${machineKey},${trackingId},PD,1001,${dims.l},${dims.b},${dims.h},${vol},${realVol},1,1,PW,0001,${weight.toFixed(2)},`;
  }

  static buildPC(machineKey: string, trackingId: string, location: string = '1049', type: ProtocolType = 'capella'): string {
    return `${machineKey},${trackingId},PC,${location},`;
  }
}

export class MachineSimulator extends EventEmitter {
  constructor(
    private transport: 'tcp' | 'serial' | 'modbus' = 'tcp',
    private options: any = { host: '127.0.0.1', port: 3000, path: '/dev/ttyUSB0' }
  ) {
    super();
  }

  async runFullCycle(
    barcode: string, 
    machineKey: string = 'MA01', 
    protocol: ProtocolType = 'capella',
    dims?: { l: number, b: number, h: number },
    weight?: number,
    edgeProfile: EdgeProfile = 'NORMAL'
  ) {
    const safeKey = (typeof machineKey === 'string' && machineKey.trim().length > 0) ? machineKey.trim() : 'MA01';
    const trackingId = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
    const d = dims || { l: 187, b: 172, h: 47 };
    const w = weight || 0.12;

    let pb = ProtocolBuilder.buildPB(safeKey, trackingId, barcode, protocol);
    let pd = ProtocolBuilder.buildPD(safeKey, trackingId, d, w, protocol);
    let pc = ProtocolBuilder.buildPC(safeKey, trackingId, '1049', protocol);

    // Apply EDGE conditions
    if (edgeProfile === 'CORRUPT_DATA') {
      pb = pb.replace('PB', 'P B');
    }
    
    this.emit('packet', pb);
    
    if (this.transport === 'tcp') {
      return this.runTCPCycle(pb, pd, pc, edgeProfile, trackingId, protocol);
    } else if (this.transport === 'serial') {
      return this.runSerialCycle(pb, pd, pc, edgeProfile, trackingId, protocol);
    } else if (this.transport === 'modbus') {
      return this.runModbusCycle(trackingId, barcode, d, w);
    }
  }

  private async runTCPCycle(pb: string, pd: string, pc: string, edgeProfile: EdgeProfile, trackingId: string, protocol: ProtocolType) {
    const { pbResp, pdResp, pcResp } = await this.sendOnTcpConnection(pb, pd, pc, edgeProfile);
    return { trackingId, protocol, pbResponse: pbResp, pdResponse: pdResp, pcResponse: pcResp, lastResponse: pbResp };
  }

  private sendOnTcpConnection(pb: string, pd: string, pc: string, edgeProfile: EdgeProfile): Promise<{ pbResp: string, pdResp: string, pcResp: string }> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      const responses: string[] = [];
      let buffer = '';
      let resolved = false;

      const finish = (val: any) => {
        if (!resolved) { resolved = true; clearTimeout(hardTimeout); client.destroy(); resolve(val); }
      };

      const hardTimeout = setTimeout(() => {
        finish({ pbResp: responses[0] || '', pdResp: responses[1] || '', pcResp: responses[2] || '' });
      }, 12000);

      client.connect(this.options.port, this.options.host, () => {
        if (edgeProfile === 'DUPLICATE_PB') {
          client.write(pb + '\n');
          setTimeout(() => client.write(pb + '\n'), 50);
        } else {
          client.write(pb + '\n');
        }

        if (edgeProfile !== 'MISSING_PD') {
          setTimeout(() => client.write(pd + '\n'), edgeProfile === 'DELAYED_PACKET' ? 1500 : 100);
        }

        setTimeout(() => client.write(pc + '\n'), edgeProfile === 'DELAYED_PACKET' ? 3000 : 800);

        setTimeout(() => finish({ pbResp: responses[0] || buffer, pdResp: responses[1] || '', pcResp: responses[2] || '' }), 4000);
      });

      client.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n').filter(l => l.trim());
        lines.forEach((line, i) => { if (!responses[i]) responses[i] = line.trim(); });
      });

      client.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(hardTimeout); reject(err); } });
    });
  }

  private async runSerialCycle(pb: string, pd: string, pc: string, edgeProfile: EdgeProfile, trackingId: string, protocol: ProtocolType) {
    return new Promise((resolve, reject) => {
      try {
        const port = new SerialPort({ path: this.options.path || '/dev/ttyUSB0', baudRate: 9600 });
        port.on('open', () => {
          port.write(pb + '\n');
          if (edgeProfile !== 'MISSING_PD') {
            setTimeout(() => port.write(pd + '\n'), 100);
          }
          setTimeout(() => port.write(pc + '\n'), 800);
        });

        port.on('error', (err) => {
          // If mock device does not exist, just resolve with simulation result anyway for testing
          resolve({ trackingId, protocol, lastResponse: 'SERIAL_ERROR_SIMULATED', err });
        });

        setTimeout(() => {
          if (port.isOpen) port.close();
          resolve({ trackingId, protocol, lastResponse: 'SERIAL_ACK' });
        }, 1500);
      } catch (err) {
        // Fallback for execution simulation
        resolve({ trackingId, protocol, lastResponse: 'SERIAL_ERROR_SIMULATED', err });
      }
    });
  }

  private async runModbusCycle(trackingId: string, barcode: string, d: any, w: any) {
    const client = new ModbusRTU();
    try {
      await client.connectTCP(this.options.host, { port: this.options.port || 502 });
      client.setID(1);
      
      // Simulate writing registers
      await client.writeRegisters(0, [parseInt(trackingId), w * 100]);
      client.close();
      return { trackingId, protocol: 'modbus', lastResponse: 'MODBUS_ACK' };
    } catch (err) {
      // Return simulated success if offline
      return { trackingId, protocol: 'modbus', lastResponse: 'MODBUS_SIMULATED', err };
    }
  }
}