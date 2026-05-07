const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Startup Script for Automation Framework
 * 
 * Order of execution:
 * 1. Kill existing node processes
 * 2. Delay 2s
 * 3. Build shared libraries (logger -> db -> server)
 * 4. Install root dependencies
 * 5. Start development environment
 */

const FRAMEWORK_ROOT = path.resolve(__dirname);

function runCommand(command, cwd, description) {
    console.log(`\n[STARTUP] ${description}...`);
    console.log(`[EXEC] ${command} (in ${cwd})`);
    try {
        execSync(command, { cwd, stdio: 'inherit' });
    } catch (error) {
        console.error(`\n[ERROR] Failed during: ${description}`);
        console.error(`[ERROR] Command: ${command}`);
        process.exit(1);
    }
}

async function main() {
    // 1. Kill any running Node.js processes (EXCEPT THIS ONE)
    console.log('[STARTUP] Cleaning up existing Node.js processes...');
    try {
        const currentPid = process.pid;
        const killCmd = `powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${currentPid} } | Stop-Process -Force"`;
        execSync(killCmd, { stdio: 'ignore' });
    } catch (e) { }

    // 2. Add a 2-second delay
    console.log('[STARTUP] Waiting 2 seconds for process cleanup...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 4. Install root dependencies
    runCommand('npm install --ignore-scripts', FRAMEWORK_ROOT, 'Installing root dependencies');

    // 5. Start the application
    console.log('\n[STARTUP] Starting application (npm run dev)...');
    // We use spawn for the final command to keep the process alive and piping output
    const devProcess = spawn('npm', ['run', 'dev:original'], {
        cwd: FRAMEWORK_ROOT,
        stdio: 'inherit',
        shell: true
    });

    devProcess.on('error', (err) => {
        console.error(`[ERROR] Failed to start dev server: ${err.message}`);
        process.exit(1);
    });
}

main();
