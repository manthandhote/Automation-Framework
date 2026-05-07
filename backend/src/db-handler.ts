import { MongoClient, Db } from 'mongodb';
import { exec } from 'child_process';
import util from 'util';
import { logger } from './logger';

const execPromise = util.promisify(exec);

export class DBHandler {
  private client: MongoClient;
  private runDbName: string;

  constructor(private mongoUri: string, runId: string) {
    this.client = new MongoClient(mongoUri);
    // Unique DB name for this specific test run
    this.runDbName = `inspectra_run_${runId}`;
  }

  async connect(): Promise<Db> {
    await this.client.connect();
    logger.info(`Connected to isolated run database: ${this.runDbName}`, 'DB');
    return this.client.db(this.runDbName);
  }

  async importDatabase(filePath: string, collectionName: string) {
    const isJson = filePath.endsWith('.json');
    logger.info(`Importing database from ${filePath} using ${isJson ? 'mongoimport' : 'mongorestore'}...`, 'DB');
    
    let command: string;
    if (isJson) {
      command = `mongoimport --uri="${this.mongoUri}" --db="${this.runDbName}" --collection="${collectionName}" --file="${filePath}" --jsonArray`;
    } else {
      // Assuming it's a binary dump or archive
      command = `mongorestore --uri="${this.mongoUri}" --nsInclude="${this.runDbName}.*" --archive="${filePath}"`;
    }
    
    try {
      const { stdout, stderr } = await execPromise(command);
      logger.info(`Import successful: ${stdout}`, 'DB');
      if (stderr) console.warn(`[DB] Import warnings:`, stderr);
    } catch (error) {
      console.error(`[DB] Import failed:`, error);
      throw new Error(`Failed to import database file: ${error}`);
    }
  }

  async seedFromConfig(configData: any) {
    const db = this.client.db(this.runDbName);
    
    // Seed machine configurations
    if (configData.machines) {
      await db.collection('machine_configurations').insertMany(configData.machines);
    }
    
    // Seed rule engine configs
    if (configData.rules) {
      await db.collection('rules').insertMany(configData.rules);
    }
    
    logger.info(`Seeding complete for ${this.runDbName}`, 'DB');
  }

  async cleanup() {
    // Optional: Drop the DB after analysis if retention policy is short
    // const db = this.client.db(this.runDbName);
    // await db.dropDatabase();
    await this.client.close();
  }

  getDbName() {
    return this.runDbName;
  }
}
