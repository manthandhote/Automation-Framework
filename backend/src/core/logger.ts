import pino from 'pino';
import path from 'path';
import fs from 'fs';

/**
 * Automyrix Control Logger (Powered by Pino)
 * Writes to console with colors and to logs/engine.log
 */

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '{tag} {msg}',
        customColors: 'info:green,warn:yellow,error:red,primary:cyan',
      },
      level: 'debug',
    },
    {
      target: 'pino/file',
      options: { destination: path.join(logDir, 'engine.log') },
      level: 'debug',
    },
  ],
});

const pinoLogger = pino(transport);

class Logger {
  private formatTag(tag: string) {
    return `[\x1b[1m${tag}\x1b[0m]`;
  }

  primary(msg: string, tag = 'SYSTEM') {
    // Custom handling for primary color #00f2ff
    const coloredMsg = `\x1b[38;2;0;242;255m${msg}\x1b[0m`;
    pinoLogger.info({ tag: this.formatTag(tag) }, coloredMsg);
  }

  info(msg: string, tag = 'INFO') {
    pinoLogger.info({ tag: this.formatTag(tag) }, msg);
  }

  warn(msg: string, tag = 'WARN') {
    pinoLogger.warn({ tag: this.formatTag(tag) }, msg);
  }

  error(msg: string, tag = 'ERROR', error?: any) {
    pinoLogger.error({ tag: this.formatTag(tag), err: error }, msg);
  }

  debug(msg: string, tag = 'DEBUG') {
    pinoLogger.debug({ tag: this.formatTag(tag) }, msg);
  }

  raw(msg: string) {
    pinoLogger.info(msg);
  }

  banner(msg: string) {
    // ASCII Banner always in primary color
    console.log(`\x1b[38;2;0;242;255m${msg}\x1b[0m`);
  }
}

export const logger = new Logger();
