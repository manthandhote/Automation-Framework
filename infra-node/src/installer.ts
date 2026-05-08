import { exec } from 'child_process';
import util from 'util';
import { logger } from './logger';

const execAsync = util.promisify(exec);

const SUDO = '/usr/bin/sudo -n';
const APT = '/usr/bin/apt-get';

const NO_PROXY_ENV = {
  ...process.env,
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  no_proxy: '*',
  NO_PROXY: '*',
};

const UBUNTU_SOURCES = (suite: string) => [
  'Types: deb',
  'URIs: http://security.ubuntu.com/ubuntu/',
  `Suites: ${suite} ${suite}-updates ${suite}-backports ${suite}-security`,
  'Components: main universe restricted multiverse',
  'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
].join('\\n');

// PHP 8.3 full dependency list for Noble (24.04)
const PHP_PACKAGES_NOBLE = [
  'php-common',
  'php8.3-common',
  'php8.3-opcache',
  'php8.3-readline',
  'php8.3-cli',
  'php8.3-fpm',
  'php8.3-mysql',
  'php8.3-zip',
  'libsodium23',
  'libzip4t64',
].join(' ');

export class Installer {

  private static aptReady = false;
  private static ubuntuSuite = 'noble'; // detected at runtime

  // ─── PUBLIC API ───────────────────────────────────────────────────────────

  static async checkAndInstallNginx(): Promise<boolean> {
    if (await Installer.isBinaryAvailable('nginx -v')) {
      logger.info('Nginx is already installed.');
      return true;
    }
    logger.info('Nginx not found. Installing...');
    if (!await Installer.verifySudo()) return false;
    await Installer.prepareApt();
    if (await Installer.aptInstall('nginx')) {
      await Installer.safeExec(`${SUDO} /usr/bin/systemctl enable nginx`);
      await Installer.safeExec(`${SUDO} /usr/bin/systemctl start nginx`);
      logger.info('Nginx installed and started.');
      return true;
    }
    logger.error('Nginx install failed. Run manually: sudo apt-get install -y nginx');
    return false;
  }

  static async checkAndInstallPhp(): Promise<boolean> {
    if (await Installer.isBinaryAvailable('php -v')) {
      logger.info('PHP is already installed.');
      return true;
    }
    logger.info('PHP not found. Installing...');
    if (!await Installer.verifySudo()) return false;
    await Installer.prepareApt();

    const suite = Installer.ubuntuSuite;

    // PHP 8.3 is only in Ubuntu 24.04 (noble) official repos.
    // Older versions need a PPA which is blocked by the proxy on this network.
    if (suite !== 'noble') {
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.error(`PHP 8.3 is NOT available on Ubuntu ${suite} via official repos.`);
      logger.error('AUTOMYRIX requires Ubuntu 24.04 (Noble) for automatic PHP 8.3 install.');
      logger.error('Please upgrade this VM to Ubuntu 24.04, then re-run npm run dev.');
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return false;
    }

    if (await Installer.aptInstall(PHP_PACKAGES_NOBLE)) {
      logger.info('PHP 8.3 installed successfully.');
      return true;
    }

    logger.error('PHP install failed. Run manually: sudo apt-get install -y php8.3-fpm php8.3-mysql php8.3-zip');
    return false;
  }

  // ─── SUDO VERIFICATION ────────────────────────────────────────────────────

  private static async verifySudo(): Promise<boolean> {
    try {
      await execAsync(`${SUDO} true`, { env: NO_PROXY_ENV, timeout: 5000 });
      return true;
    } catch {
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.error('Passwordless sudo required. Run this ONE TIME then restart:');
      logger.error('');
      logger.error("  sudo tee /etc/sudoers.d/automyrix-installer << 'EOF'");
      logger.error('  manthan ALL=(ALL) NOPASSWD: /usr/bin/apt-get');
      logger.error('  manthan ALL=(ALL) NOPASSWD: /usr/bin/dpkg');
      logger.error('  manthan ALL=(ALL) NOPASSWD: /usr/bin/tee');
      logger.error('  manthan ALL=(ALL) NOPASSWD: /usr/bin/truncate');
      logger.error('  manthan ALL=(ALL) NOPASSWD: /usr/bin/systemctl');
      logger.error('  EOF');
      logger.error('  sudo chmod 440 /etc/sudoers.d/automyrix-installer');
      logger.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return false;
    }
  }

  // ─── APT PREPARATION ──────────────────────────────────────────────────────

  private static async prepareApt(): Promise<void> {
    if (Installer.aptReady) return;
    Installer.aptReady = true;

    // Detect Ubuntu version (focal/jammy/noble)
    try {
      const { stdout } = await execAsync(
        `grep "^VERSION_CODENAME=" /etc/os-release | cut -d= -f2 | tr -d '"'`,
        { env: NO_PROXY_ENV }
      );
      Installer.ubuntuSuite = stdout.trim() || 'noble';
      logger.info(`Detected Ubuntu suite: ${Installer.ubuntuSuite}`);
    } catch {
      logger.warn('Could not detect Ubuntu version, defaulting to noble');
      Installer.ubuntuSuite = 'noble';
    }

    logger.info('Configuring apt to use security.ubuntu.com...');
    try {
      const sources = UBUNTU_SOURCES(Installer.ubuntuSuite);

      await execAsync(
        `printf '${sources}\\n' | ${SUDO} /usr/bin/tee /etc/apt/sources.list.d/ubuntu.sources > /dev/null`,
        { env: NO_PROXY_ENV }
      );

      // Clear sources.list — previous runs may have left conflicting entries
      await execAsync(
        `${SUDO} /usr/bin/truncate -s 0 /etc/apt/sources.list`,
        { env: NO_PROXY_ENV }
      );

      logger.info('Running apt-get update...');
      await execAsync(`${SUDO} ${APT} update -qq`, {
        env: NO_PROXY_ENV,
        timeout: 90000,
      });
      logger.info('apt-get update complete.');
    } catch (err: any) {
      logger.warn(`prepareApt: ${err.message?.split('\n')[0]}`);
    }
  }

  // ─── APT INSTALL ──────────────────────────────────────────────────────────

  private static async aptInstall(packages: string): Promise<boolean> {
    try {
      await execAsync(
        `${SUDO} ${APT} install -y --no-install-recommends ${packages}`,
        { env: NO_PROXY_ENV, timeout: 300000 }
      );
      return true;
    } catch (err: any) {
      logger.warn(`apt-get install failed: ${err.message?.split('\n')[0]}`);
      return false;
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  private static async isBinaryAvailable(command: string): Promise<boolean> {
    try { await execAsync(command, { env: NO_PROXY_ENV }); return true; } catch { return false; }
  }

  private static async safeExec(cmd: string, timeout = 15000): Promise<void> {
    try { await execAsync(cmd, { env: NO_PROXY_ENV, timeout }); } catch (_) { }
  }

  static async setupProjectRepos(
    backendRepoUrl: string,
    frontendRepoUrl: string,
    onProgress: (msg: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // ── 1. Ensure /data/NIDOWORKZ exists ─────────────────────────────
      onProgress('Creating /data/NIDOWORKZ directory...');
      await Installer.safeExec(`${SUDO} mkdir -p /data/NIDOWORKZ`);
      await Installer.safeExec(`${SUDO} chmod 777 /data/NIDOWORKZ`);

      // ── 2. Clone / pull backend ───────────────────────────────────────
      const backendDest = '/data/NIDOWORKZ/CSND';
      if (await Installer.pathExists(backendDest)) {
        onProgress('Backend repo already exists – pulling latest...');
        await execAsync(`git -C ${backendDest} pull`, { env: NO_PROXY_ENV, timeout: 60000 });
      } else {
        onProgress(`Cloning backend repo into ${backendDest}...`);
        await execAsync(`git clone ${backendRepoUrl} ${backendDest}`, {
          env: NO_PROXY_ENV,
          timeout: 120000,
        });
      }
      onProgress('Backend repo ready.');

      // ── 3. Clone / pull frontend ──────────────────────────────────────
      const frontendCloneDest = '/var/www/FE-CSND';
      const frontendFinalDest = '/var/www/html';

      if (await Installer.pathExists(frontendCloneDest)) {
        onProgress('Frontend repo already cloned – pulling latest...');
        await execAsync(`git -C ${frontendCloneDest} pull`, { env: NO_PROXY_ENV, timeout: 60000 });
      } else {
        onProgress(`Cloning frontend repo into ${frontendCloneDest}...`);
        await execAsync(`${SUDO} git clone ${frontendRepoUrl} ${frontendCloneDest}`, {
          env: NO_PROXY_ENV,
          timeout: 120000,
        });
      }

      // ── 4. Rename FE-CSND → html ──────────────────────────────────────
      if (!(await Installer.pathExists(frontendFinalDest))) {
        onProgress(`Renaming ${frontendCloneDest} → ${frontendFinalDest}...`);
        await execAsync(`${SUDO} mv ${frontendCloneDest} ${frontendFinalDest}`, {
          env: NO_PROXY_ENV,
        });
      } else {
        onProgress(`${frontendFinalDest} already exists – skipping rename.`);
      }
      await Installer.safeExec(`${SUDO} chmod -R 777 ${frontendFinalDest}`);
      onProgress('Frontend repo ready at /var/www/html.');

      // ── 5. Write Nginx config ─────────────────────────────────────────
      onProgress('Writing Nginx site config...');
      const nginxConfig = `server {
    listen 7001;
    server_name 127.0.0.1;

    root /var/www/html;
    index index.php index.html index.htm;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    location ~* \\.(css|js|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|svg)$ {
        access_log off;
        expires 30d;
        add_header Cache-Control "public";
    }

    location / {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin "*";
            add_header Access-Control-Allow-Methods "GET, POST, PUT, OPTIONS";
            add_header Access-Control-Allow-Headers "Authorization, Content-Type";
            add_header Access-Control-Max-Age 86400;
            return 204;
        }

        limit_except GET POST PUT {
            deny all;
        }

        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }

    location ~ /\\. { deny all; }
    location ~ ^/vendor/ { deny all; return 403; }
}
`;

      // Write to a temp file then sudo-copy it into place
      const tmpConf = '/tmp/automyrix-nginx.conf';
      await execAsync(`cat > ${tmpConf} << 'NGINXEOF'\n${nginxConfig}\nNGINXEOF`, {
        env: NO_PROXY_ENV,
      });
      await execAsync(
        `${SUDO} cp ${tmpConf} /etc/nginx/sites-available/default`,
        { env: NO_PROXY_ENV }
      );

      // Ensure symlink in sites-enabled exists
      await Installer.safeExec(
        `${SUDO} ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default`
      );
      onProgress('Nginx config written.');

      // ── 6. Patch env.php ──────────────────────────────────────────────
      const envPhp = '/var/www/html/includes/env.php';
      if (await Installer.pathExists(envPhp)) {
        onProgress('Patching env.php (IP + path)...');
        // Replace any bare IP that looks like a LAN address with 127.0.0.1
        await execAsync(
          `${SUDO} sed -i "s|192\\.168\\.[0-9]\\+\\.[0-9]\\+|127.0.0.1|g" ${envPhp}`,
          { env: NO_PROXY_ENV }
        );
        // Replace /FE-CSND/ with /
        await execAsync(
          `${SUDO} sed -i "s|/FE-CSND/|/|g" ${envPhp}`,
          { env: NO_PROXY_ENV }
        );
        onProgress('env.php patched.');
      } else {
        onProgress(`WARNING: ${envPhp} not found – skipping patch.`);
      }

      // ── 7. Validate & reload Nginx ────────────────────────────────────
      onProgress('Testing Nginx configuration...');
      await execAsync(`${SUDO} nginx -t`, { env: NO_PROXY_ENV, timeout: 10000 });
      await execAsync(`${SUDO} /usr/bin/systemctl reload nginx`, {
        env: NO_PROXY_ENV,
        timeout: 15000,
      });
      onProgress('Nginx reloaded. Setup complete ✓');

      return { success: true };
    } catch (err: any) {
      const msg = err.message?.split('\n')[0] ?? String(err);
      logger.error(`setupProjectRepos failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // inside the private helpers section – add this small utility:
  private static async pathExists(p: string): Promise<boolean> {
    try { await execAsync(`test -e ${p}`, { env: NO_PROXY_ENV }); return true; } catch { return false; }
  }
}