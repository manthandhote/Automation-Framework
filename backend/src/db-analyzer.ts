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

  public async mergeAllIntoSessionDb(): Promise<void> {
    // ── BYPASSED ──────────────────────────────────────────────────────────────
    // Services now use their original databases as defined in each service's
    // .env file. No session-specific DB merging is needed.
    //
    // To re-enable session isolation, remove the early return below and restore
    // the original merge logic that follows it.
    // ─────────────────────────────────────────────────────────────────────────
    logger.info('[MERGE] mergeAllIntoSessionDb is bypassed — using original DBs', 'DB-ANALYZER');
    return;

    /* ── ORIGINAL MERGE LOGIC (kept for reference / re-enable) ──────────────
    const client = new MongoClient(this.mongoUri);
    const skipDbs = ['admin', 'local', 'config', 'inspectra_meta'];
 
    try {
      await client.connect();
      const admin = client.db().admin();
      const dbList = await admin.listDatabases();
      const targetDb = client.db(this.restoredDbName);
 
      for (const dbInfo of dbList.databases) {
        if (skipDbs.includes(dbInfo.name)) continue;
        if (dbInfo.name === this.restoredDbName) continue;
        if (dbInfo.name.startsWith('inspectra_csnd_')) continue;
        if (dbInfo.name.startsWith('temp_analysis_')) continue;
 
        const sourceDb = client.db(dbInfo.name);
        const collections = await sourceDb.listCollections().toArray();
 
        for (const col of collections) {
          const data = await sourceDb.collection(col.name).find().toArray();
          if (data.length === 0) continue;
 
          try {
            await targetDb.collection(col.name).insertMany(data, { ordered: false });
            logger.info(`[MERGE] ${dbInfo.name}.${col.name} → ${this.restoredDbName}.${col.name} (${data.length} docs)`, 'DB-ANALYZER');
          } catch (err: any) {
            if (err.code === 11000 || err.name === 'MongoBulkWriteError') {
              logger.warn(`[MERGE] Duplicates skipped in ${col.name}`, 'DB-ANALYZER');
            } else {
              throw err;
            }
          }
        }
      }
 
      logger.info(`[MERGE] All data merged into ${this.restoredDbName}`, 'DB-ANALYZER');
    } finally {
      await client.close();
    }
    ── END ORIGINAL MERGE LOGIC ─────────────────────────────────────────── */
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
      // machine_configurations also contains calibration_config, incoming_data_config, etc.
      // inside the machine document — those are already loaded above as sub-fields.
      // Separately scan config-related collections in machine_configurations:
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