import { MongoClient, Db, ObjectId } from 'mongodb';
import { logger } from './logger';

const INSPECTRA_DB_NAME = process.env.INSPECTRA_DB_NAME || 'inspectra_meta';
const INSPECTRA_DB_URI  = process.env.INSPECTRA_DB_URI  || 'mongodb://127.0.0.1:27018';

export interface Session {
  _id?: ObjectId;
  sessionId: string;
  clientName: string;
  machineCount: number;
  machineDescriptions: string;
  beRepo: string;
  beBranch: string;
  feRepo: string;
  feBranch: string;
  codeDir: string;
  dbBackupPath?: string;
  restoredDbName?: string;
  machineIds?: string[];
  beCommit?: string;
  feCommit?: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: Date;
  completedAt?: Date;
}

export interface GeneratedTestCase {
  _id?: ObjectId;
  sessionId: string;
  testId: string;
  service: string;
  scenario: string;
  description: string;
  expectedStatus: 'PASS' | 'FAIL';
  payload?: any;
  barcode?: string;
  machineName?: string;
  machineId?: string;
  configName?: string;
  generatedBy: 'llm' | 'heuristic';
  createdAt: Date;
}

export interface TestResult {
  _id?: ObjectId;
  sessionId: string;
  testId: string;
  barcode: string;
  service: string;
  scenario?: string;
  expectedStatus?: 'PASS' | 'FAIL';
  status: 'PASS' | 'FAIL' | 'ERROR';
  passed?: boolean;
  rejectionCode?: string;
  reason?: string;
  trace?: any;
  uiFound?: boolean;
  uiDisplayedStatus?: string;
  uiDisplayedRejection?: string;
  uiStatus?: 'PASS' | 'FAIL' | 'HEALED' | 'ERROR';
  uiDurationMs?: number;
  executedAt: Date;
}

export interface AiAnalysis {
  _id?: ObjectId;
  sessionId: string;
  codeInsights: string;
  dbInsights: string;
  scalingPlan: any;
  recommendations: string[];
  failureAnalysis?: string[];
  generatedAt: Date;
}

export class InspectraDB {
  private static instance: InspectraDB;
  private client: MongoClient;
  private db!: Db;
  private static config: { uri: string, name: string } | null = null;

  static init(uri: string, name: string) {
    this.config = { uri, name };
  }

  static getInstance(): InspectraDB {
    if (!InspectraDB.instance) {
      const uri = this.config?.uri || INSPECTRA_DB_URI;
      const name = this.config?.name || INSPECTRA_DB_NAME;
      InspectraDB.instance = new InspectraDB(uri, name);
    }
    return InspectraDB.instance;
  }
  async deleteTestCases(sessionId: string): Promise<void> {
    const collection = this.db.collection('test_cases');
    await collection.deleteMany({ sessionId });
    logger.info(`[DB] Deleted test cases for session ${sessionId}`, 'DB');
  }

  private constructor(uri: string, private dbName: string) {
    this.client = new MongoClient(uri);
  }

  private connected = false;

  private get database(): Db {
    if (!this.db) {
      throw new Error('InspectraDB not connected. Please ensure MongoDB is running and the URI is correct.');
    }
    return this.db;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      // Ensure indexes exist
      await this.db.collection('sessions').createIndex({ sessionId: 1 }, { unique: true });
      await this.db.collection('generated_test_cases').createIndex({ sessionId: 1 });
      await this.db.collection('test_results').createIndex({ sessionId: 1 });
      await this.db.collection('ai_analysis').createIndex({ sessionId: 1 });
      this.connected = true;
      logger.info(`Connected to ${this.dbName}`, 'INSPECTRA-DB');
    } catch (err: any) {
      logger.error(`Failed to connect to InspectraDB (${this.dbName}): ${err.message}`, 'INSPECTRA-DB');
      throw err;
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────────

  async createSession(session: Omit<Session, '_id'>): Promise<string> {
    await this.database.collection<Session>('sessions').insertOne(session as Session);
    return session.sessionId;
  }

  async updateSession(sessionId: string, update: Partial<Session>): Promise<void> {
    await this.database.collection('sessions').updateOne({ sessionId }, { $set: update });
  }

  async getSessions(): Promise<Session[]> {
    return this.database.collection<Session>('sessions').find().sort({ startedAt: -1 }).toArray();
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.database.collection<Session>('sessions').findOne({ sessionId });
  }

  async getLatestSessionForRepo(repoUrl: string): Promise<Session | null> {
    return this.database.collection<Session>('sessions').findOne(
      { beRepo: repoUrl },
      { sort: { startedAt: -1 } }
    );
  }

  // ─── Test Cases ──────────────────────────────────────────────────────────────

  async saveTestCases(cases: Omit<GeneratedTestCase, '_id'>[]): Promise<void> {
    if (cases.length === 0) return;
    await this.database.collection<GeneratedTestCase>('generated_test_cases').insertMany(cases as GeneratedTestCase[]);
  }

  async getTestCases(sessionId: string): Promise<GeneratedTestCase[]> {
    return this.database.collection<GeneratedTestCase>('generated_test_cases').find({ sessionId }).toArray();
  }

  // ─── Test Results ─────────────────────────────────────────────────────────────

  async saveResult(result: Omit<TestResult, '_id'>): Promise<void> {
    await this.database.collection<TestResult>('test_results').insertOne(result as TestResult);
  }

  async getResults(sessionId: string): Promise<TestResult[]> {
    return this.database.collection<TestResult>('test_results').find({ sessionId }).toArray();
  }

  // ─── AI Analysis ─────────────────────────────────────────────────────────────

  async saveAnalysis(analysis: Omit<AiAnalysis, '_id'>): Promise<void> {
    await this.database.collection<AiAnalysis>('ai_analysis').insertOne(analysis as AiAnalysis);
  }

  async getAnalysis(sessionId: string): Promise<AiAnalysis | null> {
    return this.database.collection<AiAnalysis>('ai_analysis').findOne({ sessionId });
  }

  async updateAnalysis(sessionId: string, update: Partial<AiAnalysis>): Promise<void> {
    await this.database.collection('ai_analysis').updateOne({ sessionId }, { $set: update });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
