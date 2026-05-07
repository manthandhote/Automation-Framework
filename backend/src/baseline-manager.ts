import { InspectraDB } from './inspectra-db';
import { logger } from './logger';

export interface BaselineData {
  commit_id: string;
  selectors: Record<string, string>;
  expected_steps: any[];
  api_mapping: Record<string, string>;
}

export class BaselineManager {
  private db: InspectraDB;

  constructor() {
    this.db = InspectraDB.getInstance();
  }

  async getBaseline(commitId: string): Promise<BaselineData | null> {
    const database = (this.db as any).database;
    if (!database) return null;
    const collection = database.collection('baselines');
    return await collection.findOne({ commit_id: commitId });
  }

  async saveBaseline(data: BaselineData): Promise<void> {
    const database = (this.db as any).database;
    if (!database) return;
    const collection = database.collection('baselines');
    await collection.updateOne(
      { commit_id: data.commit_id },
      { $set: data },
      { upsert: true }
    );
    logger.info(`[BASELINE] Saved baseline for commit ${data.commit_id}`, 'BASELINE-MANAGER');
  }

  async updateHealedSelector(commitId: string, key: string, newSelector: string): Promise<void> {
    const database = (this.db as any).database;
    if (!database) return;
    const collection = database.collection('baselines');
    
    const updateQuery: any = {};
    updateQuery[`selectors.${key}`] = newSelector;
    
    await collection.updateOne(
      { commit_id: commitId },
      { $set: updateQuery }
    );
    logger.info(`[BASELINE] Healed selector for ${key} in commit ${commitId}`, 'BASELINE-MANAGER');
  }
}
