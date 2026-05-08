import axios from 'axios';
import { logger } from './logger';
import { CodeSummary } from './code-analyzer';
import { DbSummary } from './db-analyzer';

export interface ScalingRecommendation {
  service: string;
  instances: number;
  reason: string;
}
export interface RealAwbContext {
  machineId: string;
  machineName: string;   // machine_name e.g. "Astro001"
  machineKey: string;    // machine_key e.g. "MA01"
  barcodeRegex: string;
  validAwb: string | null;   // real AWB from incoming_data
  fakeAwb: string;           // valid format, not in DB
}

export interface GeneratedTestCase {
  testId: string;
  service: string;
  scenario: string;
  description: string;
  expectedStatus: 'PASS' | 'FAIL';
  expectedSortCode?: string;
  barcode?: string;
  machineName?: string;
  machineId?: string;
  configName?: string;
  isDuplicate?: boolean;
  dims?: { l: number, b: number, h: number };  // ← add
  weight?: number;                               // ← add
}

export class LlamaAnalyst {
  private endpoint: string;
  private model: string;

  constructor() {
    this.endpoint = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/api/generate';
    this.model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
  }

  // ─── Core request helper ─────────────────────────────────────────────────────
  private async ask(prompt: string, expectJson: boolean = true, retries: number = 3): Promise<string> {
    const timeout = Number(process.env.LLM_TIMEOUT_MS) || 300000;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.info(`[AI] Attempt ${attempt}/${retries} — sending prompt (${prompt.length} chars)...`, 'AI');

        const response = await axios.post(this.endpoint, {
          model: this.model,
          prompt,
          stream: false,
        }, { timeout });

        let text: string = response.data.response || '';
        console.log('\n================ LLM RAW RESPONSE ================\n');
        console.log(text);
        console.log('\n=================================================\n');
        logger.info(`[AI] Got response (${text.length} chars)`, 'AI');
        text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        return text;

      } catch (err: any) {
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        logger.warn(`[AI] Attempt ${attempt} failed: ${err.message}`, 'AI');

        if (attempt < retries) {
          const waitMs = isTimeout ? 5000 : 2000;
          logger.info(`[AI] Retrying in ${waitMs}ms...`, 'AI');
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          logger.error(`[AI] All ${retries} attempts failed`, 'AI');
          throw err;
        }
      }
    }
    throw new Error('LLM ask failed after all retries');
  }

  // ─── 1. Analyze System Config (original, kept for backward compat) ────────────
  async analyzeConfig(dbConfig: any): Promise<{ scaling: ScalingRecommendation[], machinePatterns: any[] }> {
    logger.info(`Analyzing system config using ${this.model}...`, 'AI');

    if (process.env.AI_ANALYSIS_ENABLED === 'false') {
      return this.heuristicFallback(dbConfig);
    }

    try {
      const prompt = `You are an infrastructure expert for a CSND logistics sorting system.
        Analyze the provided machine configuration and recommend scaling for microservices.
        Configuration:
        ${JSON.stringify(dbConfig)}

        STRICT SCALING RULES (DO NOT VIOLATE):

        1. Total services = 6:
          - validation-service
          - app-device-interface
          - incoming-service
          - mapper-service
          - dataposting-service
          - backend-for-frontend

        2. Scaling Logic:
          - validation-service = number of machines
          - app-device-interface = number of machines

          - incoming-service = ALWAYS 1
          - mapper-service = ALWAYS 1
          - dataposting-service = ALWAYS 1
          - backend-for-frontend = ALWAYS 1

        3. Machine count:
          - Use totalMachines from config
          - If missing, count machines array length

        4. Machine patterns:
          - Each machine must be included
          - Default:
            - throughput = 500
            - type = "sorter"

        Return ONLY valid JSON (NO markdown, NO explanation):

        {
          "scaling": [
            { "service": "validation-service", "instances": 2, "reason": "Based on machine count" },
            { "service": "app-device-interface", "instances": 2, "reason": "Based on machine count" },
            { "service": "incoming-service", "instances": 1, "reason": "Shared service" },
            { "service": "mapper-service", "instances": 1, "reason": "Shared service" },
            { "service": "dataposting-service", "instances": 1, "reason": "Shared service" },
            { "service": "backend-for-frontend", "instances": 1, "reason": "Shared service" }
          ],
          "machinePatterns": [
            { "id": "machine-1", "throughput": 500, "type": "sorter" }
          ]
        }`;

      const text = await this.ask(prompt);
      const data = JSON.parse(text);
      const machineCount =
        dbConfig?.totalMachines ||
        dbConfig?.machines?.length ||
        1;

      const safeScaling = [
        { service: 'validation-service', instances: machineCount, reason: 'Based on machine count' },
        { service: 'app-device-interface', instances: machineCount, reason: 'Based on machine count' },
        { service: 'incoming-service', instances: 1, reason: 'Shared service' },
        { service: 'mapper-service', instances: 1, reason: 'Shared service' },
        { service: 'dataposting-service', instances: 1, reason: 'Shared service' },
        { service: 'backend-for-frontend', instances: 1, reason: 'Shared service' }
      ];

      return {
        scaling: data.scaling?.length === 6 ? data.scaling : safeScaling,
        machinePatterns: data.machinePatterns || []
      };

    } catch (err: any) {
      console.warn(`[AI] analyzeConfig failed, using heuristic. Error: ${err.message}`);
      return this.heuristicFallback(dbConfig);
    }
  }

  // ─── 2. Analyze Cloned Codebase ──────────────────────────────────────────────
  async analyzeCodebase(codeSummary: CodeSummary): Promise<string> {
    logger.info(`Analyzing codebase structure (${codeSummary.totalServices} services)...`, 'AI');

    const prompt = `You are an expert software architect reviewing a CSND logistics automation system.
Here is a structured summary of the cloned codebase:
${JSON.stringify(codeSummary, null, 2)}

Provide a concise paragraph (max 5 sentences) describing:
1. The overall architecture and key microservices
2. The data flow between services
3. Any notable patterns or concerns for automated testing

Return plain text only, no JSON, no markdown.`;

    try {
      return await this.ask(prompt, false);
    } catch (err: any) {
      console.warn(`[AI] analyzeCodebase failed. Error: ${err.message}`);
      return `System contains ${codeSummary.totalServices} microservices including: ${codeSummary.services.map(s => s.name).join(', ')}.`;
    }
  }

  // ─── 3. Analyze Restored Database ────────────────────────────────────────────
  async analyzeDatabase(dbSummary: DbSummary): Promise<string> {
    logger.info(`Analyzing database (${dbSummary.totalMachines} machines)...`, 'AI');

    const prompt = `You are a QA expert for a CSND sortation system.
Here is the database structure extracted from the system's MongoDB backup:
${JSON.stringify(dbSummary, null, 2)}

Provide a concise paragraph (max 5 sentences) describing:
1. What machines are configured and what types they are
2. What client integrations exist (push/pull/fetch configs)
3. Which services and collections are most critical for testing

Return plain text only, no JSON, no markdown.`;

    try {
      return await this.ask(prompt, false);
    } catch (err: any) {
      console.warn(`[AI] analyzeDatabase failed. Error: ${err.message}`);
      return `Found ${dbSummary.totalMachines} machines with ${dbSummary.totalConfigs} configurations for clients: ${dbSummary.clients.join(', ')}.`;
    }
  }

  // ─── 4. Generate Test Cases ───────────────────────────────────────────────────
  async generateTestCases(codeSummary: CodeSummary, dbSummary: DbSummary, realAwbs?: RealAwbContext[]): Promise<GeneratedTestCase[]> {
    const machineList = dbSummary.machines.map(m => m.name).join(', ');
    logger.info(`Generating test cases for machines: ${machineList}`, 'AI');

    // Build context string from real DB data
    const awbContext = realAwbs?.map(ctx => `
      Machine: ${ctx.machineName} (key: ${ctx.machineKey}, _id: ${ctx.machineId})
      Regex: ${ctx.barcodeRegex}
      Valid AWB from DB (exists in incoming_data): ${ctx.validAwb || 'NONE FOUND'}
      Fake AWB (matches regex but NOT in DB): ${ctx.fakeAwb}
      Invalid AWB (fails regex): INVALID000
    `).join('\n') || '';

    const prompt = `You are a QA automation engineer for a CSND logistics sortation system.

    REAL DATA FROM DATABASE (use these exact values — do not invent barcodes):
    ${awbContext}

    MACHINES:
    ${JSON.stringify(dbSummary.machines.map(m => ({
      name: m.name,
      type: m.type,
      machine_key: (m as any).machine_key
    })), null, 2)}

    MICROSERVICES:
    ${JSON.stringify(codeSummary.services.map(s => ({ name: s.name, port: s.port })), null, 2)}

    Generate EXACTLY these test cases for EACH machine that has a valid AWB:

    1. NORMAL FLOW: Use the "Valid AWB from DB" barcode → expectedSortCode: "SUCC"
    2. DNF REJECTION: Use the "Fake AWB" barcode (valid format, not in DB) → expectedSortCode: "DNFR"  
    3. INVALID BARCODE: Use "INVALID000" → expectedSortCode: "IBAR"
    4. DUPLICATE SCAN: Use the same "Valid AWB from DB" again → expectedSortCode: "SBRR", set isDuplicate: true

    STRICT RULES:
    - NEVER invent barcodes. Use ONLY the exact AWB values provided above.
    - machineName must be the machine_key (e.g. "MA01"), NOT the machine_name
    - machineId must be the _id field provided
    - expectedSortCode must be one of: SUCC, DNFR, IBAR, SBRR

    Return ONLY valid JSON array, no markdown, no explanation:
    [
      {
        "testId": "TC-001",
        "service": "app-device-interface",
        "scenario": "normal_flow",
        "description": "AWB exists in incoming_data → expect SUCC",
        "expectedStatus": "PASS",
        "expectedSortCode": "SUCC",
        "barcode": "<exact valid AWB from DB>",
        "machineName": "<machine_key e.g. MA01>",
        "machineId": "<exact _id>",
        "configName": "normal_flow",
        "isDuplicate": false
      }
    ]`;

    try {
      const text = await this.ask(prompt);
      let cleaned = text.trim();

      // Remove markdown
      cleaned = cleaned
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

      // Fix unquoted UUID machineId values
      cleaned = cleaned.replace(
        /"machineId"\s*:\s*([a-zA-Z0-9-]{20,})/g,
        '"machineId": "$1"'
      );

      logger.info(`[AI] Cleaned response:\n${cleaned}`, 'AI');

      const cases: GeneratedTestCase[] = JSON.parse(cleaned);
      logger.info(`Generated ${cases.length} test cases`, 'AI');

      // ── CRITICAL SAFETY VALIDATION ──
      // Reject any case where LLM invented a barcode not in our known set
      const knownAwbs = new Set(realAwbs?.flatMap(ctx => [ctx.validAwb, ctx.fakeAwb, 'INVALID000'].filter(Boolean)));

      const validatedCases = cases.filter(tc => {
        if (!tc.barcode) return false;
        if (knownAwbs.size > 0 && !knownAwbs.has(tc.barcode)) {
          logger.warn(`[AI] Rejected hallucinated barcode: ${tc.barcode}`, 'AI');
          return false;
        }
        return true;
      });

      if (validatedCases.length === 0) {
        logger.warn(`[AI] All generated cases were invalid, using deterministic fallback`, 'AI');
        return this.deterministicTestCases(realAwbs || []);
      }

      return validatedCases.map((tc, i) => ({
        ...tc,
        testId: tc.testId || `TC-${String(i + 1).padStart(3, '0')}`,
        dims: tc.dims || { l: 187, b: 172, h: 47 },
        weight: tc.weight ?? 0.12
      }));

    } catch (err: any) {
      logger.error(`[AI] generateTestCases failed: ${err.message}`, 'AI');
      return this.deterministicTestCases(realAwbs || []);
    }
  }
  private deterministicTestCases(realAwbs: RealAwbContext[]): GeneratedTestCase[] {
    const cases: GeneratedTestCase[] = [];
    let idx = 1;

    for (const ctx of realAwbs) {
      if (ctx.validAwb) {
        cases.push({
          testId: `TC-${String(idx++).padStart(3, '0')}`,
          service: 'app-device-interface',
          scenario: 'normal_flow',
          description: `AWB exists in incoming_data → expect SUCC`,
          expectedStatus: 'PASS',
          expectedSortCode: 'SUCC',
          barcode: ctx.validAwb,
          machineName: ctx.machineKey,
          machineId: ctx.machineId,
          configName: 'normal_flow',
          isDuplicate: false,
          dims: { l: 187, b: 172, h: 47 },  // real values from your machine config
          weight: 0.12
        });

        cases.push({
          testId: `TC-${String(idx++).padStart(3, '0')}`,
          service: 'app-device-interface',
          scenario: 'duplicate_scan',
          description: `Same AWB fed twice → expect SBRR`,
          expectedStatus: 'FAIL',
          expectedSortCode: 'SBRR',
          barcode: ctx.validAwb,
          machineName: ctx.machineKey,
          machineId: ctx.machineId,
          configName: 'duplicate_scan',
          isDuplicate: true,
          dims: { l: 187, b: 172, h: 47 },  // real values from your machine config
          weight: 0.12
        });
      }

      cases.push({
        testId: `TC-${String(idx++).padStart(3, '0')}`,
        service: 'app-device-interface',
        scenario: 'dnf_rejection',
        description: `Valid format AWB not in DB → expect DNFR`,
        expectedStatus: 'FAIL',
        expectedSortCode: 'DNFR',
        barcode: ctx.fakeAwb,
        machineName: ctx.machineKey,
        machineId: ctx.machineId,
        configName: 'dnf_rejection',
        isDuplicate: false,
        dims: { l: 187, b: 172, h: 47 },  // real values from your machine config
        weight: 0.12
      });

      cases.push({
        testId: `TC-${String(idx++).padStart(3, '0')}`,
        service: 'app-device-interface',
        scenario: 'invalid_barcode',
        description: `Barcode fails regex → expect IBAR`,
        expectedStatus: 'FAIL',
        expectedSortCode: 'IBAR',
        barcode: 'INVALID000',
        machineName: ctx.machineKey,
        machineId: ctx.machineId,
        configName: 'invalid_barcode',
        isDuplicate: false,
        dims: { l: 187, b: 172, h: 47 },
        weight: 0.12,
      });
    }

    return cases;
  }



  // ─── 5. Analyze Failures ─────────────────────────────────────────────────────
  async analyzeFailures(failedResults: any[]): Promise<string[]> {
    if (failedResults.length === 0) return [];
    logger.info(`Analyzing ${failedResults.length} failed test cases...`, 'AI');

    const prompt = `You are a senior QA engineer investigating test failures in a CSND sorting system.
      Here are the failed test results:
      ${JSON.stringify(failedResults, null, 2)}

      For each failure, provide a concise root cause analysis and recommended fix.
      CRITICAL: You MUST explicitly consider the following potential root causes:
      - MongoDB connection failures
      - ConfigManager load issues
      - Cache expiry
      - Mapper mismatch
      - Uploader failure
      - JWT auth issues

      Return ONLY a valid JSON array of strings (one insight per failure group):
      ["Insight 1: ...", "Insight 2: ..."]`;

    try {
      const text = await this.ask(prompt);
      const insights: string[] = JSON.parse(text);
      return insights;
    } catch (err: any) {
      console.warn(`[AI] analyzeFailures failed. Error: ${err.message}`);
      return failedResults.map(r => `Test ${r.testId || r.barcode} failed: ${r.reason || 'Unknown error'}`);
    }
  }

  // ─── Fallbacks ────────────────────────────────────────────────────────────────
  private heuristicFallback(dbConfig: any) {
    return {
      scaling: [
        { service: 'incoming-service', instances: 1, reason: 'Heuristic fallback — LLM offline' },
        { service: 'mapper-service', instances: 1, reason: 'Heuristic fallback' },
        { service: 'dataposting-service', instances: 1, reason: 'Heuristic fallback' }
      ],
      machinePatterns: []
    };
  }

  private heuristicTestCases(dbSummary: DbSummary): GeneratedTestCase[] {
    const cases: GeneratedTestCase[] = [];
    let idx = 1;

    for (const machine of dbSummary.machines.filter(m => m.status).slice(0, 5)) {
      cases.push({
        testId: `TC-${String(idx++).padStart(3, '0')}`,
        service: 'incoming-service',
        scenario: 'normal_flow',
        description: `Normal barcode scan for machine: ${machine.name}`,
        expectedStatus: 'PASS',
        barcode: `AWB${Math.floor(Math.random() * 9999999999)}`,
        machineName: machine.name,
        configName: machine.configs[0]?.name || 'default'
      });
      cases.push({
        testId: `TC-${String(idx++).padStart(3, '0')}`,
        service: 'incoming-service',
        scenario: 'invalid_barcode',
        description: `Invalid barcode rejection for machine: ${machine.name}`,
        expectedStatus: 'FAIL',
        barcode: 'INVALID_AWB_000',
        machineName: machine.name,
        configName: machine.configs[0]?.name || 'default'
      });
    }

    return cases;
  }
}
