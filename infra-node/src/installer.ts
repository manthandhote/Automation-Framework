import { exec } from 'child_process';
import util from 'util';
import { logger } from './logger';

const execAsync = util.promisify(exec);

export class Installer {
  static async checkAndInstallNginx() {
    try {
      await execAsync('nginx -v');
      logger.info('Nginx is already installed.');
      return true;
    } catch {
      logger.info('Nginx not found. Installing...');
      try {
        await execAsync('apt-get update && apt-get install -y nginx');
        logger.info('Nginx installed successfully.');
        return true;
      } catch (err: any) {
        logger.error({ err }, 'Failed to install Nginx');
        return false;
      }
    }
  }

  static async checkAndInstallPhp() {
    try {
      await execAsync('php -v');
      logger.info('PHP is already installed.');
      return true;
    } catch {
      logger.info('PHP not found. Installing...');
      try {
        await execAsync('apt-get update && apt-get install -y php-fpm php-mysql');
        logger.info('PHP installed successfully.');
        return true;
      } catch (err: any) {
        logger.error({ err }, 'Failed to install PHP');
        return false;
      }
    }
  }
}
