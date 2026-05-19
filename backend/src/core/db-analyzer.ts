import { MongoClient } from 'mongodb';
import { logger } from './logger';

export interface MachineInfo {
  id: string;
  name: string;
  machine_key: string;
  type: string;
  location: string;
  status: boolean;
  configCount: number;
  configs: IncomingConfigInfo[];
  isCsnd: boolean;
  modbusConnections?: Array<{
  connectionId: number;
  slaveId: number;
  registerAddress: number;
  portName: string;
}>;
  devices?: Array<{ device_id?: number; data?: string; connection_id?: number | string }>;
  machineServicesConfig?: Record<string, any>;
  deviceConfig?: any;

  // ── Port info extracted from machine doc ─────────────────────────────────
  // tcpPort:              device_config.connection_pools[barcode device].port_name
  //                       This is the TCP port the physical scanner/PLC connects to.
  //                       Used by test-runner to send PB/PD/PC packets.
  //
  // appDevicePort:        machine_services_config['app-device-interface'].port
  //                       One per machine — test-runner waits for this before tests.
  //
  // validationEnginePort: machine_services_config['validation-engine'].port
  //                       One per machine — test-runner waits for this before tests.
  tcpPort: number;
  appDevicePort: number;
  validationEnginePort: number;
}

export interface IncomingConfigInfo {
  id: string;
  name: string;
  type: string;
  client?: string;
  route?: string;
  method?: string;
  destination_collection?: string;
  mappingCount: number;
}

export interface DbSummary {
  dbName: string;
  totalMachines: number;
  activeMachines: number;
  machines: MachineInfo[];
  totalConfigs: number;
  clients: string[];
  configTypes: Record<string, number>;
}

export class DbAnalyzer {
  private mongoUri: string;
  private restoredDbName: string;

  constructor(mongoUri: string, restoredDbName: string) {
    this.mongoUri = mongoUri;
    this.restoredDbName = restoredDbName;
  }

  public async mergeAllIntoSessionDb(): Promise<void> {
    logger.info('[MERGE] mergeAllIntoSessionDb is bypassed — using original DBs', 'DB-ANALYZER');
    return;
  }

  async analyze(): Promise<DbSummary> {
    logger.info(`Analyzing databases (machines: machine_configurations, configs: ${this.restoredDbName})...`, 'DB-ANALYZER');
    const client = new MongoClient(this.mongoUri);
    const machines: MachineInfo[] = [];
    const clients: Set<string> = new Set();
    const configTypes: Record<string, number> = {};
    let totalConfigs = 0;

    const MACHINE_DB = 'machine_configurations';

    try {
      await client.connect();

      // ── Step 1: Read machines ─────────────────────────────────────────────
      const machineDb = client.db(MACHINE_DB);
      const rawMachines = await machineDb.collection('machines').find().toArray();
      logger.info(`[DIAGNOSTIC] Found ${rawMachines.length} docs in ${MACHINE_DB}.machines`, 'DB-ANALYZER');

      for (const m of rawMachines) {
        const id = (m._id ? m._id.toString() : null) || m.machine_id || m.machineId || m.id || m.code;
        const name = m.machine_name || m.machineName || m.name || id;

        if (!id) continue;

        logger.info(`[DIAGNOSTIC] Found machine ID: ${id}`, 'DB-ANALYZER');

        // ── Extract TCP port ────────────────────────────────────────────────
        // device_config.devices[data==='barcode'].connection_id
        //   → device_config.connection_pools[connection_id].port_name
        const barcodeDevice = (m.device_config?.devices || [])
          .find((d: any) => d.data === 'barcode');
        const barcodeConnectionId = barcodeDevice?.connection_id
          ? parseInt(String(barcodeDevice.connection_id), 10)
          : null;
        const barcodePool = barcodeConnectionId !== null
          ? (m.device_config?.connection_pools || [])
            .find((cp: any) => parseInt(String(cp.connection_id), 10) === barcodeConnectionId)
          : null;
        const tcpPort = parseInt(String(barcodePool?.port_name || '3000'), 10);

        // ── Extract per-machine service ports ───────────────────────────────
        const svcConfig = m.machine_services_config || {};
        const appDevicePort: number =
          svcConfig['app-device-interface']?.port || 5500;
        const validationEnginePort: number =
          svcConfig['validation-engine']?.port || 5000;
        const machineType = (m.machine_type || '').toUpperCase();
        const isCsnd = machineType === 'CSND' ||
          (m.device_config?.connection_pools || []).some((cp: any) => cp.type === 'Modbus');

        const modbusConnections = isCsnd
          ? (m.device_config?.connection_pools || [])
              .filter((cp: any) => cp.type === 'Modbus')
              .map((cp: any) => ({
                connectionId: cp.connection_id,
                slaveId: cp.slave_id,
                registerAddress: cp.register_address || 0,
                portName: cp.port_name,
              }))
          : [];

        logger.info(
          `[DIAGNOSTIC] Machine ${name} (${id}) — TCP:${tcpPort} appDevice:${appDevicePort} validation:${validationEnginePort}`,
          'DB-ANALYZER'
        );

        machines.push({
          id: id.toString(),
          name: name.toString(),
          machine_key: m.machine_key || id.toString(),
          type: m.machine_type || m.type || 'sorter',
          location: m.machine_location || m.location || 'Local',
          status: m.machine_status === 'Running' || m.status !== false,
          configCount: 0,
          configs: [],
          tcpPort,
          appDevicePort,
          validationEnginePort,
          isCsnd,
          modbusConnections,
          devices: m.device_config?.devices || [],
          machineServicesConfig: svcConfig,
          deviceConfig: m.device_config,
        });

        if (m.client_name) clients.add(m.client_name);
      }

      // ── Step 2: Read configs from machine_configurations itself ───────────
      const machineDbCols = await machineDb.listCollections().toArray();
      for (const col of machineDbCols) {
        const lowerName = col.name.toLowerCase();
        const isConfigCol = lowerName.includes('config') || lowerName.includes('incoming') || lowerName.includes('sorting');
        const isMachineCol = lowerName === 'machines' || lowerName === 'machines_backup';
        if (!isConfigCol || isMachineCol) continue;

        const configs = await machineDb.collection(col.name).find().toArray();
        if (configs.length === 0) continue;
        totalConfigs += configs.length;
        configTypes[col.name] = (configTypes[col.name] || 0) + configs.length;
        for (const cfg of configs) {
          const machineId = cfg.machine_id || cfg.machineId || cfg.machine || cfg.machine_name;
          const matchedMachine = machines.find(m => m.id === machineId || m.name === machineId);
          if (matchedMachine) {
            matchedMachine.configs.push({
              id: cfg._id?.toString() || 'unknown',
              name: cfg.name || cfg.config_name || 'unknown',
              type: cfg.type || cfg.payload_type || 'unknown',
              client: cfg.client,
              route: cfg.route,
              method: cfg.method,
              destination_collection: cfg.destination_collection,
              mappingCount: cfg.mapping ? Object.keys(cfg.mapping).length : 0
            });
            matchedMachine.configCount += 1;
          }
        }
      }

      const uniqueMachines = Array.from(new Map(machines.map(m => [m.id, m])).values());
      let finalMachines = uniqueMachines;

      if (finalMachines.length === 0) {
        logger.warn(`[FALLBACK] No machines found in ${MACHINE_DB}.machines`, 'DB-ANALYZER');
        finalMachines = [{
          id: '', name: 'unknown', machine_key: 'unknown', type: 'sorter',
          location: 'unknown', status: true, configCount: 0, configs: [],
          tcpPort: 3000, appDevicePort: 5500, validationEnginePort: 5000,
          isCsnd: false,
        }];
      }

      if (finalMachines.filter(m => m.status).length === 0) {
        finalMachines[0].status = true;
      }

      logger.info(`[DISCOVERY] Final machine count: ${finalMachines.length}`, 'DB-ANALYZER');

      return {
        dbName: MACHINE_DB,
        totalMachines: finalMachines.length,
        activeMachines: finalMachines.filter(m => m.status).length,
        machines: finalMachines,
        totalConfigs,
        clients: Array.from(clients),
        configTypes
      };
    } catch (err: any) {
      logger.error(`Discovery failed: ${err.message}`, 'DB-ANALYZER');
      throw err;
    } finally {
      await client.close();
    }
  }
}
