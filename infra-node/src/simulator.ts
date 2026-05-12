import { EventEmitter } from 'events';
import * as net from 'net';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export type EdgeProfile =
  | 'NORMAL'
  | 'MISSING_PD'
  | 'DUPLICATE_PB'
  | 'DELAYED_PACKET'
  | 'CORRUPT_DATA';

export interface SimulationStep {
  type: 'PB' | 'PD' | 'PC';
  packet: string;
  response: string;
  accepted: boolean;
}

export interface SimulationResult {
  trackingId: string;
  barcode: string;
  machineKey: string;
  steps: SimulationStep[];
  /** SORTED = full cycle completed. REJECTED_PB / REJECTED_PD = chain stopped at that step. */
  finalStatus: 'SORTED' | 'REJECTED_PB' | 'REJECTED_PD' | 'ERROR' | 'INCOMPLETE';
  sortLocation?: string;    // controller_value from PB response e.g. "1013"
  rejectionCode?: string;   // e.g. "IBAR", "DNFR", "WULR", "LOLR", "DUPR"
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Packet Builders
//
//  Exact formats confirmed from live logs + Hercules:
//
//  PB:  MA01,0003,PB,FL01,A,1001,VL0084016900365
//  PD:  MA01,0003,PD,1001,187,172,47,1519622,1010378,1,1,PW,0001,               0.12,
//       weight is right-padded to 15 chars with leading spaces, trailing comma
//  PC:  MA01,0003,PC,1013
//       sort location = controller_value from PB SUCC response
// ═══════════════════════════════════════════════════════════════════════════════

export class ProtocolBuilder {
  /**
   * PB: MA01,<tid>,PB,FL01,A,1001,<barcode>
   */
  static buildPB(machineKey: string, tid: string, barcode: string): string {
    return `${machineKey},${tid},PB,FL01,A,1001,${barcode}`;
  }

  /**
   * PD+PW: MA01,<tid>,PD,1001,<l>,<w>,<h>,<vol>,<realVol>,1,1,PW,<pwId>,               <weight>,
   *
   * volume    = l * w * h
   * realVolume = floor(volume * 0.665)
   * weight field is right-padded (leading spaces) to 15 characters, followed by trailing comma
   */
  static buildPD(
    machineKey: string,
    tid: string,
    dims: { l: number; w: number; h: number },
    weight: number = 0.12,
    pwId: string = '0001'
  ): string {
    // Accept either 'w' (width) or 'b' (breadth) — normalize to avoid undefined
    const breadth = (dims as any).w ?? (dims as any).b ?? 172;
    const volume = dims.l * breadth * dims.h;
    const realVolume = Math.floor(volume * 0.665);
    const weightStr = weight.toFixed(2).padStart(15); // 15-char field with leading spaces
    return `${machineKey},${tid},PD,1001,${dims.l},${breadth},${dims.h},${volume},${realVolume},1,1,PW,${pwId},${weightStr},`;
  }

  /**
   * PC: MA01,<tid>,PC,<sortLocation>
   * sortLocation comes from the controller_value field in the PB SUCC response
   */
  static buildPC(machineKey: string, tid: string, sortLocation: string): string {
    return `${machineKey},${tid},PC,${sortLocation}`;
  }

  /** Random 4-digit TID, zero-padded */
  static randomTid(): string {
    return Math.floor(Math.random() * 9999).toString().padStart(4, '0');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Response Parsers
//
//  PB response: MA01,<tid>,PB,<scan_id>,<controller_value>,<display>
//    SUCC:      MA01,0003,PB,1001,1013,SUCC
//    rejected:  MA01,0003,PB,1001,9001,IBAR
//
//  PD response: MA01,<tid>,PD,<scan_id>,<ctrl>,PW,<pw_id>,<ctrl>,<display>
//    SUCC:      MA01,0003,PD,1001,1013,PW,0001,1013,SUCC
//    rejected:  MA01,0003,PD,1001,9001,PW,0001,9001,LOLR
//
//  PC response: MA01,<tid>,PC
// ═══════════════════════════════════════════════════════════════════════════════

function parsePbResponse(raw: string): {
  tid: string;
  controllerValue: string;
  display: string;
  accepted: boolean;
} | null {
  const parts = raw.trim().split(',');
  if (parts.length < 6 || parts[2] !== 'PB') return null;
  return {
    tid: parts[1],
    controllerValue: parts[4],
    display: parts[5],
    accepted: parts[5] === 'SUCC',
  };
}

function parsePdResponse(raw: string): {
  tid: string;
  display: string;
  accepted: boolean;
} | null {
  const parts = raw.trim().split(',');
  if (parts.length < 9 || parts[2] !== 'PD') return null;
  return {
    tid: parts[1],
    display: parts[8],
    accepted: parts[8] === 'SUCC',
  };
}

function parsePcResponse(raw: string): boolean {
  return raw.trim().split(',')[2] === 'PC';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TCP Helper — one fresh connection per packet, waits for response before return
// ═══════════════════════════════════════════════════════════════════════════════

function sendTcp(
  host: string,
  port: number,
  packet: string,
  timeoutMs: number = 10000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = '';
    let settled = false;

    const finish = (result: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result.trim());
    };

    const timer = setTimeout(
      () => finish(new Error(`TCP timeout (${timeoutMs}ms) — packet: ${packet}`)),
      timeoutMs
    );

    client.connect(port, host, () => {
      client.write(packet + '\r\n');
    });

    client.on('data', (data) => {
      response += data.toString();
      finish(response);
    });

    client.on('close', () => finish(response));
    client.on('error', (err) => finish(err));
  });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MachineSimulator
// ═══════════════════════════════════════════════════════════════════════════════

export class MachineSimulator extends EventEmitter {
  private host: string;
  private port: number;
  private machineKey: string;

  constructor(options: {
    host?: string;
    port?: number;
    machineKey?: string;
  } = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 3000;
    this.machineKey = options.machineKey ?? 'MA01';
  }

  private log(msg: string) {
    console.log(msg);
    this.emit('log', msg);
  }

  // ── Connectivity check ─────────────────────────────────────────────────────

  async checkConnectivity(): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new net.Socket();
      const timer = setTimeout(() => { client.destroy(); resolve(false); }, 3000);
      client.connect(this.port, this.host, () => {
        clearTimeout(timer);
        client.destroy();
        resolve(true);
      });
      client.on('error', () => { clearTimeout(timer); resolve(false); });
    });
  }

  // ── Main cycle ─────────────────────────────────────────────────────────────

  /**
   * Simulate one parcel through the full PB → PD → PC chain.
   *
   * The chain is CONDITIONAL:
   *   - PD is only sent if PB response display === 'SUCC'
   *   - PC is only sent if PD response display === 'SUCC'
   *   - Any rejection stops the chain immediately
   *
   * Edge profiles:
   *   NORMAL        — standard conditional flow
   *   MISSING_PD    — skip PD entirely (sensor fault simulation); stop after PB
   *   DUPLICATE_PB  — send PB twice before proceeding; both responses logged
   *   DELAYED_PACKET — add 1500ms before sending PD
   *   CORRUPT_DATA  — malform the PB string so parser rejects it
   */
  async runCycle(
    barcode: string,
    dims: { l: number; w: number; h: number } = { l: 187, w: 172, h: 47 },
    weight: number = 0.12,
    edgeProfile: EdgeProfile = 'NORMAL',
    tidOverride?: string
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    const tid = tidOverride ?? ProtocolBuilder.randomTid();
    const mk = this.machineKey;
    const steps: SimulationStep[] = [];

    const result: SimulationResult = {
      trackingId: tid,
      barcode,
      machineKey: mk,
      steps,
      finalStatus: 'INCOMPLETE',
      durationMs: 0,
    };

    try {

      // ── STEP 1: PB ─────────────────────────────────────────────────────────
      let pbPacket = ProtocolBuilder.buildPB(mk, tid, barcode);

      if (edgeProfile === 'CORRUPT_DATA') {
        pbPacket = pbPacket.replace(',PB,', ',P B,');
        this.log(`[SIM][${tid}] ⚠ CORRUPT_DATA — malformed packet: ${pbPacket}`);
      }

      this.log(`[SIM][${tid}] → PB: ${pbPacket}`);
      this.emit('packet', { type: 'PB', packet: pbPacket });

      const pbRaw = await sendTcp(this.host, this.port, pbPacket);
      this.log(`[SIM][${tid}] ← PB: ${pbRaw || '(empty)'}`);

      const pbParsed = parsePbResponse(pbRaw);
      steps.push({ type: 'PB', packet: pbPacket, response: pbRaw, accepted: pbParsed?.accepted ?? false });

      // DUPLICATE_PB edge: send PB a second time, log cached response
      if (edgeProfile === 'DUPLICATE_PB') {
        await sleep(200);
        this.log(`[SIM][${tid}] → PB (duplicate): ${pbPacket}`);
        const pbRaw2 = await sendTcp(this.host, this.port, pbPacket);
        this.log(`[SIM][${tid}] ← PB (duplicate): ${pbRaw2 || '(empty)'}`);
        this.emit('packet', { type: 'PB', packet: pbPacket, duplicate: true, response: pbRaw2 });
      }

      // PB rejected → stop chain
      if (!pbParsed?.accepted) {
        result.finalStatus = 'REJECTED_PB';
        result.rejectionCode = pbParsed?.display ?? 'UNKNOWN';
        result.durationMs = Date.now() - startTime;
        this.log(`[SIM][${tid}] ✗ PB rejected (${result.rejectionCode}) — stopping chain`);
        return result;
      }

      // PB accepted — extract sort location for PC
      const sortLocation = pbParsed.controllerValue;
      result.sortLocation = sortLocation;
      this.log(`[SIM][${tid}] ✓ PB accepted — sort location: ${sortLocation}`);

      // ── STEP 2: PD ─────────────────────────────────────────────────────────

      // MISSING_PD edge: skip PD, return incomplete
      if (edgeProfile === 'MISSING_PD') {
        this.log(`[SIM][${tid}] ⚠ MISSING_PD — skipping PD step`);
        result.finalStatus = 'INCOMPLETE';
        result.durationMs = Date.now() - startTime;
        return result;
      }

      const pdDelay = edgeProfile === 'DELAYED_PACKET' ? 1500 : 400;
      await sleep(pdDelay);

      const pdPacket = ProtocolBuilder.buildPD(mk, tid, dims, weight);
      this.log(`[SIM][${tid}] → PD: ${pdPacket}`);
      this.emit('packet', { type: 'PD', packet: pdPacket });

      const pdRaw = await sendTcp(this.host, this.port, pdPacket);
      this.log(`[SIM][${tid}] ← PD: ${pdRaw || '(empty)'}`);

      const pdParsed = parsePdResponse(pdRaw);
      steps.push({ type: 'PD', packet: pdPacket, response: pdRaw, accepted: pdParsed?.accepted ?? false });

      // PD rejected → stop chain
      if (!pdParsed?.accepted) {
        result.finalStatus = 'REJECTED_PD';
        result.rejectionCode = pdParsed?.display ?? 'UNKNOWN';
        result.durationMs = Date.now() - startTime;
        this.log(`[SIM][${tid}] ✗ PD rejected (${result.rejectionCode}) — stopping chain`);
        return result;
      }

      this.log(`[SIM][${tid}] ✓ PD accepted`);

      // ── STEP 3: PC ─────────────────────────────────────────────────────────
      await sleep(400);

      const pcPacket = ProtocolBuilder.buildPC(mk, tid, sortLocation);
      this.log(`[SIM][${tid}] → PC: ${pcPacket}`);
      this.emit('packet', { type: 'PC', packet: pcPacket });

      const pcRaw = await sendTcp(this.host, this.port, pcPacket);
      this.log(`[SIM][${tid}] ← PC: ${pcRaw || '(empty)'}`);

      const pcOk = parsePcResponse(pcRaw);
      steps.push({ type: 'PC', packet: pcPacket, response: pcRaw, accepted: pcOk });

      result.finalStatus = pcOk ? 'SORTED' : 'INCOMPLETE';
      this.log(`[SIM][${tid}] ${pcOk ? '✓ SORTED successfully' : '✗ PC response unexpected'}`);

    } catch (err: any) {
      result.finalStatus = 'ERROR';
      result.durationMs = Date.now() - startTime;
      this.log(`[SIM][${tid}] 💥 ERROR: ${err.message}`);
      this.emit('error', err);
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Batch runner ───────────────────────────────────────────────────────────

  /**
   * Run multiple parcels sequentially with a gap between each.
   */
  async runBatch(
    parcels: Array<{
      barcode: string;
      dims?: { l: number; w: number; h: number };
      weight?: number;
      edgeProfile?: EdgeProfile;
    }>,
    gapMs: number = 1000
  ): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];
    for (const p of parcels) {
      const r = await this.runCycle(
        p.barcode,
        p.dims ?? { l: 187, w: 172, h: 47 },
        p.weight ?? 0.12,
        p.edgeProfile ?? 'NORMAL'
      );
      results.push(r);
      this.emit('result', r);
      if (gapMs > 0) await sleep(gapMs);
    }
    return results;
  }
}