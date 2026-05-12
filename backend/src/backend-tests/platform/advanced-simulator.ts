import * as net from 'net';
import { logger } from '../../core/logger';
import * as fs from 'fs';
import * as path from 'path';
import csv from 'csv-parser';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

export interface SimulationResult {
  barcode: string;
  triggerId: number;
  pbResponse: string;
  pdResponse: string;
  pcResponse: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export class AdvancedSimulator extends EventEmitter {
  private currentTriggerId: number = 9504;
  public csvData: any[] = [];
  private resultsMap: Map<string, string> = new Map();

  constructor(private host: string = '127.0.0.1', private port: number = 3000) {
    super();
  }

  async loadCsvData(csvPath: string): Promise<void> {
    if (!fs.existsSync(csvPath)) {
      console.warn(`[AdvancedSimulator] CSV not found at ${csvPath}`);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on('data', (data) => {
          this.csvData.push(data);
          const awb = data['AWB'];
          const location = data['Sorting Confirmation Location'];
          if (awb && location) {
            this.resultsMap.set(awb, location);
          }
        })
        .on('end', () => {
          console.log(`[AdvancedSimulator] Loaded ${this.csvData.length} records.`);
          resolve();
        })
        .on('error', (error) => reject(error));
    });
  }

  /**
   * Build the Astro-format PB (Barcode) string.
   * Format: MA01,<TID>,PB,<FeedLane>,<Mode>,<ScanId>,<Barcode>
   */
  static buildPB(machineKey: string, triggerId: string, barcode: string, feedlane: string = 'FL01', mode: string = 'A', scanId: string = '1001'): string {
    return `${machineKey},${triggerId},PB,${feedlane},${mode},${scanId},${barcode}`;
  }

  /**
   * Build the Astro-format PD+PW (Dimension + Weight) string.
   * Format: MA01,<TID>,PD,<DimId>,<L>,<W>,<H>,<Vol>,<RVol>,<ShipCount>,<ShapeType>,PW,<WtId>,<Weight>,<PkgType>
   */
  static buildPD(machineKey: string, triggerId: string, dims: { l: number; b: number; h: number }, weight: number = 0.5, dimId: string = '1001'): string {
    const vol = dims.l * dims.b * dims.h;
    return `${machineKey},${triggerId},PD,${dimId},${dims.l},${dims.b},${dims.h},${vol},${vol},1,1,PW,0001,${weight.toFixed(3)},`;
  }

  /**
   * Build the Astro-format PC (Parcel Confirmation) string.
   * Format: MA01,<TID>,PC,<Location>,<RejectCode>
   */
  static buildPC(machineKey: string, triggerId: string, location: string = '1035', rejectCode: string = ''): string {
    return `${machineKey},${triggerId},PC,${location},${rejectCode}`;
  }

  /**
   * Send a single TCP packet and wait for the ACK response.
   * Each packet gets its own connection (matching real PLC behavior).
   */
  private async sendAndReceive(packet: string, timeoutMs: number = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let response = '';
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          client.destroy();
          reject(new Error(`TCP Timeout after ${timeoutMs}ms for packet: ${packet.substring(0, 50)}...`));
        }
      }, timeoutMs);

      client.connect(this.port, this.host, () => {
        client.write(packet + '\n');
      });

      client.on('data', (data) => {
        response += data.toString();
        // Got response — close connection
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          client.destroy();
          resolve(response.trim());
        }
      });

      client.on('close', () => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve(response.trim());
        }
      });

      client.on('error', (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          client.destroy();
          reject(new Error(`TCP error: ${err.message}`));
        }
      });
    });
  }

  /**
   * Run a complete PB → PD → PC cycle for a single barcode.
   * Sends each packet sequentially, waiting for the ACK from each before proceeding.
   */
  async runFullCycle(barcode: string, machineKey: string = 'MA01', protocol: string = 'capella'): Promise<SimulationResult> {
    const triggerId = this.currentTriggerId++;
    const tid = triggerId.toString().padStart(4, '0');
    const startTime = Date.now();

    // Find matched data from CSV if available
    const rowData = this.csvData.find(d => d['AWB'] === barcode);

    // 1. PB Barcode String
    const pb = AdvancedSimulator.buildPB(machineKey, tid, barcode);

    // 2. PD DWS String
    let l = 250, w = 200, h = 150, weight = 0.5;
    if (rowData) {
      l = Math.floor(parseFloat(rowData['Package Length']) * 10) || l;
      w = Math.floor(parseFloat(rowData['Package Width']) * 10) || w;
      h = Math.floor(parseFloat(rowData['Package Height']) * 10) || h;
      weight = parseFloat(rowData['Package Weight']) / 1000 || weight;
    }
    const pd = AdvancedSimulator.buildPD(machineKey, tid, { l, b: w, h }, weight);

    // 3. PC Confirmation String
    const sortingLocation = rowData?.['Sorting Confirmation Location'] || this.resultsMap.get(barcode) || '1035';
    const pc = AdvancedSimulator.buildPC(machineKey, tid, sortingLocation);

    const result: SimulationResult = {
      barcode,
      triggerId,
      pbResponse: '',
      pdResponse: '',
      pcResponse: '',
      success: false,
      durationMs: 0,
    };

    try {
      console.log(`[AdvancedSimulator] → PB: ${pb}`);
      this.emit('packet', `[SIM→ADI] PB: ${pb}`);
      result.pbResponse = await this.sendAndReceive(pb);
      this.emit('packet', `[ADI→SIM] PB Response: ${result.pbResponse}`);
      console.log(`[AdvancedSimulator] ← PB Response: ${result.pbResponse}`);

      // Small delay between PB and PD (realistic hardware timing)
      await this.delay(300);

      console.log(`[AdvancedSimulator] → PD: ${pd}`);
      this.emit('packet', `[SIM→ADI] PD: ${pd}`);
      result.pdResponse = await this.sendAndReceive(pd);
      this.emit('packet', `[ADI→SIM] PD Response: ${result.pdResponse}`);
      console.log(`[AdvancedSimulator] ← PD Response: ${result.pdResponse}`);

      // Delay before PC (parcel moves to chute)
      await this.delay(500);

      console.log(`[AdvancedSimulator] → PC: ${pc}`);
      this.emit('packet', `[SIM→ADI] PC: ${pc}`);
      result.pcResponse = await this.sendAndReceive(pc);
      this.emit('packet', `[ADI→SIM] PC Response: ${result.pcResponse}`);
      console.log(`[AdvancedSimulator] ← PC Response: ${result.pcResponse}`);

      result.success = true;
    } catch (err: any) {
      result.error = err.message;
      this.emit('packet', `[SIM ERROR] ${err.message}`);
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  private delay(ms: number) {
    return new Promise(res => setTimeout(res, ms));
  }
}
