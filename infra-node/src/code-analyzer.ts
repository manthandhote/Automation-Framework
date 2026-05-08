import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface ServiceInfo {
  name: string;
  port?: number;
  hasDb: boolean;
  dbNames: string[];
  endpoints: string[];
  models: string[];
}

export interface CodeSummary {
  totalServices: number;
  services: ServiceInfo[];
  sharedLibs: string[];
  techStack: string[];
  framework: string;
}

export class CodeAnalyzer {
  constructor(private csndPath: string) {}

  async analyze(): Promise<CodeSummary> {
    logger.info(`Analyzing cloned codebase at: ${this.csndPath}`);

    const services: ServiceInfo[] = [];
    const sharedLibs: string[] = [];

    // Scan apps/ directory
    const appsDir = path.join(this.csndPath, 'apps');
    if (fs.existsSync(appsDir)) {
      const serviceNames = fs.readdirSync(appsDir).filter(n =>
        fs.statSync(path.join(appsDir, n)).isDirectory()
      );

      for (const name of serviceNames) {
        const svcPath = path.join(appsDir, name);
        const info = this.analyzeService(name, svcPath);
        services.push(info);
      }
    }

    // Scan libs/
    const libsDir = path.join(this.csndPath, 'libs');
    if (fs.existsSync(libsDir)) {
      const libs = fs.readdirSync(libsDir).filter(n =>
        fs.statSync(path.join(libsDir, n)).isDirectory()
      );
      sharedLibs.push(...libs);
    }

    const summary: CodeSummary = {
      totalServices: services.length,
      services,
      sharedLibs,
      techStack: ['TypeScript', 'Node.js', 'Express', 'MongoDB'],
      framework: 'npm workspaces monorepo'
    };

    logger.info(`Found ${services.length} services: ${services.map(s => s.name).join(', ')}`);
    return summary;
  }

  private analyzeService(name: string, svcPath: string): ServiceInfo {
    const srcPath = path.join(svcPath, 'src');
    const dbNames: string[] = [];
    const endpoints: string[] = [];
    const models: string[] = [];
    let port: number | undefined;

    // Try to read package.json for port hints
    const pkgPath = path.join(svcPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.start) {
          const portMatch = pkg.scripts.start.match(/PORT[=\s]+(\d+)/);
          if (portMatch) port = parseInt(portMatch[1]);
        }
      } catch { /* skip */ }
    }

    // Guess port from service name
    if (!port) {
      const portMap: Record<string, number> = {
        'incoming-service': 7002,
        'validation-engine': 5000,
        'mapper-service': 4000,
        'dataposting-service': 4100,
        'backend-for-frontend': 5026,
        'app-device-interface': 5500,
        'alarm-service': 5200,
        'monitoring-service': 5300,
      };
      port = portMap[name];
    }

    // Walk src/ to find DB references and model files
    if (fs.existsSync(srcPath)) {
      this.walkDir(srcPath, (filePath) => {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');

          // Extract DB names from ENV references (MONGO_URI, DB names)
          const dbMatches = content.match(/ENV\.(\w+_DB)\b/g) || [];
          dbMatches.forEach(m => {
            const dbKey = m.replace('ENV.', '');
            if (!dbNames.includes(dbKey)) dbNames.push(dbKey);
          });

          // Extract model names from Model files
          if (filePath.includes('/models/') || filePath.includes('\\models\\')) {
            const modelMatch = path.basename(filePath, '.ts');
            if (!models.includes(modelMatch)) models.push(modelMatch);
          }

          // Extract route endpoints
          const routeMatches = content.match(/router\.(get|post|put|delete)\(['"`]([^'"`]+)['"`]/g) || [];
          routeMatches.forEach(r => {
            const ep = r.match(/['"`]([^'"`]+)['"`]/);
            if (ep && !endpoints.includes(ep[1])) endpoints.push(ep[1]);
          });

          // Also catch app.get/post patterns
          const appRoutes = content.match(/app\.(get|post|put|delete)\(['"`]([^'"`]+)['"`]/g) || [];
          appRoutes.forEach(r => {
            const ep = r.match(/['"`]([^'"`]+)['"`]/);
            if (ep && !endpoints.includes(ep[1])) endpoints.push(ep[1]);
          });
        } catch { /* skip unreadable */ }
      });
    }

    return {
      name,
      port,
      hasDb: dbNames.length > 0,
      dbNames,
      endpoints: endpoints.slice(0, 15), // cap for LLM context size
      models
    };
  }

  private walkDir(dir: string, fn: (filePath: string) => void): void {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && entry !== 'node_modules' && entry !== '.git') {
          this.walkDir(fullPath, fn);
        } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
          fn(fullPath);
        }
      }
    } catch { /* skip permission errors */ }
  }
}
