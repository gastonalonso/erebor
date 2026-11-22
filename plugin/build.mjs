// Bundles the plugin; with --install, also copies it into the vault.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';

const PLUGIN_DIR = import.meta.dirname;
const REPO_DIR = resolve(PLUGIN_DIR, '..');
const BUNDLE = join(PLUGIN_DIR, 'dist/main.js');
const PLUGIN_ID = JSON.parse(
  readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf8'),
).id;
const INSTALLED = `.obsidian/plugins/${PLUGIN_ID}`;

await build({
  entryPoints: [join(PLUGIN_DIR, 'src/main.ts')],
  outfile: BUNDLE,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  define: { REPO_DIR: JSON.stringify(REPO_DIR) },
  logLevel: 'info',
});

function configuredVault() {
  const configFile = process.env.EREBOR_CONFIG ?? join(REPO_DIR, 'config.json');
  const { vault } = JSON.parse(readFileSync(configFile, 'utf8'));
  return vault.replace(/^~(?=$|\/)/, homedir());
}

// The vault copy is a build of this repo, so the vault's history skips it,
// as it does the installed skill.
function excludeFromVaultRepo(vault) {
  const exclude = join(vault, '.git/info/exclude');
  if (!existsSync(join(vault, '.git'))) return;
  const entry = `/${INSTALLED}/`;
  const lines = existsSync(exclude)
    ? readFileSync(exclude, 'utf8').split('\n')
    : [];
  if (lines.includes(entry)) return;
  mkdirSync(join(vault, '.git/info'), { recursive: true });
  appendFileSync(exclude, `${entry}\n`);
}

if (process.argv.includes('--install')) {
  const vault = configuredVault();
  const target = join(vault, INSTALLED);
  mkdirSync(target, { recursive: true });
  copyFileSync(BUNDLE, join(target, 'main.js'));
  copyFileSync(
    join(PLUGIN_DIR, 'manifest.json'),
    join(target, 'manifest.json'),
  );
  excludeFromVaultRepo(vault);
  console.log(`Installed the plugin at ${target}`);
}
