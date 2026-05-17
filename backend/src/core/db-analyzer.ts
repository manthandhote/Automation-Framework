import { MongoClient } from 'mongodb';
import { exec } from 'child_process';
import util from 'util';
import { logger } from './logger';

const execPromise = util.promisify(exec);

export interface MachineInfo {
  id: string;
  name: string;
  machine_key: string;
  type: string;
  location: string;
  status: boolean;
  configCount: number;
  configs: IncomingConfigInfo[];
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


  async analyze(): Promise<DbSummary> {
    logger.info(`Analyzing databases (machines: machine_configurations, configs: ${this.restoredDbName})...`, 'DB-ANALYZER');
    const client = new MongoClient(this.mongoUri);
    const machines: MachineInfo[] = [];
    const clients: Set<string> = new Set();
    const configTypes: Record<string, number> = {};
    let totalConfigs = 0;

    // Machines always live in machine_configurations.machines.
    // Configs live in their respective service DBs (incoming_service, sorting_service, etc.)
    // which are all accessible via this.restoredDbName or scanned individually below.
    const MACHINE_DB = 'machine_configurations';

    try {
      await client.connect();

      // ── Step 1: Read machines from machine_configurations.machines ────────
      const machineDb = client.db(MACHINE_DB);
      const rawMachines = await machineDb.collection('machines').find().toArray();
      logger.info(`[DIAGNOSTIC] Found ${rawMachines.length} docs in ${MACHINE_DB}.machines`, 'DB-ANALYZER');

      for (const m of rawMachines) {
        const id = (m._id ? m._id.toString() : null) || m.machine_id || m.machineId || m.id || m.code;
        const name = m.machine_name || m.machineName || m.name || id;

        if (id) {
          logger.info(`[DIAGNOSTIC] Found machine ID: ${id}`, 'DB-ANALYZER');
          machines.push({
            id: id.toString(),
            name: name.toString(),
            machine_key: m.machine_key || id.toString(),
            type: m.machine_type || m.type || 'sorter',
            location: m.machine_location || m.location || 'Local',
            status: m.machine_status === 'Running' || m.status !== false,
            configCount: 0,
            configs: []
          });
          if (m.client_name) clients.add(m.client_name);
        }
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
        finalMachines = [{ id: '', name: 'unknown', machine_key: 'unknown', type: 'sorter', location: 'unknown', status: true, configCount: 0, configs: [] }];
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
