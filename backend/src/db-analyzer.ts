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

  async restoreBackup(archivePath: string): Promise<void> {
    logger.info(`Restoring backup from ${archivePath}...`, 'DB-ANALYZER');

    const isArchive = !archivePath.endsWith('/') && !archivePath.endsWith('\\');
    let command = `mongorestore --uri="${this.mongoUri}" --drop --noIndexRestore`;
    if (isArchive) {
      command += ` --archive="${archivePath}"`;
    } else {
      command += ` "${archivePath}"`;
    }

    try {
      const { stdout, stderr } = await execPromise(command);
      if (stdout) logger.debug(`Restore stdout: ${stdout.trim()}`, 'DB-ANALYZER');
      if (stderr) logger.debug(`Restore stderr: ${stderr.trim()}`, 'DB-ANALYZER');
      logger.info(`Backup restored successfully`, 'DB-ANALYZER');

      await this.mergeAllIntoSessionDb();
    } catch (err: any) {
      logger.error(`Restore failed: ${err.message}`, 'DB-ANALYZER');
      throw new Error(`Failed to restore MongoDB backup: ${err.message}`);
    }
  }

  private async mergeAllIntoSessionDb(): Promise<void> {
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
  }

  async analyze(): Promise<DbSummary> {
    logger.info(`Analyzing database: ${this.restoredDbName}...`, 'DB-ANALYZER');
    const client = new MongoClient(this.mongoUri);
    const machines: MachineInfo[] = [];
    const clients: Set<string> = new Set();
    const configTypes: Record<string, number> = {};
    let totalConfigs = 0;

    try {
      await client.connect();
      const db = client.db(this.restoredDbName);
      const collections = await db.listCollections().toArray();
      const collectionNames = collections.map(c => c.name);

      logger.info(`[DIAGNOSTIC] Found ${collectionNames.length} collections in ${this.restoredDbName}`, 'DB-ANALYZER');

      for (const colName of collectionNames) {
        const lowerName = colName.toLowerCase();

        const isMachineCol = lowerName === 'machines';
         // (lowerName.includes('machine') && !lowerName.includes('log') && !lowerName.includes('backup') && !lowerName.includes('status'));

        const isConfigCol = lowerName.includes('config') || lowerName.includes('incoming') || lowerName.includes('sorting');

        if (isMachineCol) {
          const raw = await db.collection(colName).find().toArray();
          logger.info(`[DIAGNOSTIC] Scanning '${colName}' (${raw.length} docs)...`, 'DB-ANALYZER');

          for (const m of raw) {
            const id = (m._id ? m._id.toString() : null) || m.machine_id || m.machineId || m.id || m.code;
            const name = m.machine_name || m.machineName || m.name || id;

            if (id) {
              logger.info(`[DIAGNOSTIC] Found machine ID: ${id} in ${colName}`, 'DB-ANALYZER');
              machines.push({
                id: id.toString(),
                name: name.toString(),
                machine_key: m.machine_key || id.toString(),   // ← ADD THIS
                type: m.machine_type || m.type || 'sorter',
                location: m.machine_location || m.location || 'Local',
                status: m.machine_status === 'Running' || m.status !== false,
                configCount: 0,
                configs: []
              });
              if (m.client_name) clients.add(m.client_name);
            }
          }
        }

        if (isConfigCol && !isMachineCol) {
          const configs = await db.collection(colName).find().toArray();
          if (configs.length > 0) {
            totalConfigs += configs.length;
            configTypes[colName] = (configTypes[colName] || 0) + configs.length;

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
        }
      }

      const uniqueMachines = Array.from(new Map(machines.map(m => [m.id, m])).values());
      let finalMachines = uniqueMachines;

      if (finalMachines.length === 0) {
        logger.warn(`[FALLBACK] No machines found`, 'DB-ANALYZER');
        finalMachines = [{ id: '', name: 'unknown', machine_key: 'unknown', type: 'sorter', location: 'unknown', status: true, configCount: 0, configs: [] }];
      }

      if (finalMachines.filter(m => m.status).length === 0) {
        finalMachines[0].status = true;
      }

      logger.info(`[DISCOVERY] Final machine count: ${finalMachines.length}`, 'DB-ANALYZER');

      return {
        dbName: this.restoredDbName,
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