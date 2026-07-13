import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Check if bun is installed
try {
  execSync('bun --version', { stdio: 'ignore' });
} catch (e) {
  console.error('[undomcp] Error: "bun" compiler is not installed or not in PATH.');
  console.error('Please install Bun (https://bun.sh) to compile the single-binary standalone executable.');
  process.exit(1);
}

const targets = [
  { name: 'macos-arm64', target: 'bun-darwin-arm64', ext: '' },
  { name: 'macos-x64', target: 'bun-darwin-x64', ext: '' },
  { name: 'linux-arm64', target: 'bun-linux-arm64', ext: '' },
  { name: 'linux-x64', target: 'bun-linux-x64', ext: '' },
  { name: 'win-x64', target: 'bun-windows-x64', ext: '.exe' }
];

const buildDir = path.resolve('./dist/bin');
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

console.log('[undomcp] Starting Bun compilation...');

const buildAll = process.argv.includes('--all');

if (buildAll) {
  for (const t of targets) {
    const outfile = path.join(buildDir, `undomcp-${t.name}${t.ext}`);
    console.log(`[undomcp] Compiling for target ${t.target} -> ${outfile}...`);
    try {
      execSync(`bun build --compile --minify --sourcemap --target=${t.target} ./src/index.ts --outfile "${outfile}"`, { stdio: 'inherit' });
      console.log(`[undomcp] Successfully compiled target ${t.name}`);
    } catch (err) {
      console.error(`[undomcp] Failed compiling for target ${t.target}: ${err.message}`);
    }
  }
} else {
  // Build host platform
  const outfile = path.join(buildDir, process.platform === 'win32' ? 'undomcp.exe' : 'undomcp');
  console.log(`[undomcp] Compiling for host platform -> ${outfile}...`);
  try {
    execSync(`bun build --compile --minify --sourcemap ./src/index.ts --outfile "${outfile}"`, { stdio: 'inherit' });
    console.log(`[undomcp] Successfully compiled for host platform`);
  } catch (err) {
    console.error(`[undomcp] Failed compilation: ${err.message}`);
    process.exit(1);
  }
}
