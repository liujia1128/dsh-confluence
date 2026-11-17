#!/usr/bin/env node
/**
 * Installs this plugin's runtime dependencies from `deps/node_modules.tar.gz`
 * without touching the network, for machines that cannot run `npm install`.
 *
 * What it does: verify the archive against `deps/node_modules.sha256`, then
 * extract it into the package root as `node_modules/`.
 *
 * After that, add THIS DIRECTORY as the DSH plugin. A linked local directory
 * does not run a package install for the plugin's dependencies, so the
 * extracted tree is what the plugin uses.
 *
 * Usage:
 *   node scripts/install-offline.mjs            # refuses to replace node_modules
 *   node scripts/install-offline.mjs --force    # replaces an existing tree
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depsDir = path.join(root, 'deps');
const archive = path.join(depsDir, 'node_modules.tar.gz');
const checksumFile = path.join(depsDir, 'node_modules.sha256');
const target = path.join(root, 'node_modules');
const force = process.argv.includes('--force');

function fail(message) {
  console.error(`install-offline: ${message}`);
  process.exitCode = 1;
}

if (fs.existsSync(archive) === false) {
  fail(`missing ${path.relative(root, archive)}. Run "npm run deps:pack" on a machine with network access first.`);
  process.exit(1);
}
if (fs.existsSync(checksumFile) === false) {
  fail(`missing ${path.relative(root, checksumFile)}; cannot verify the archive.`);
  process.exit(1);
}

const expected = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (expected !== actual) {
  fail(`checksum mismatch.\n  expected ${expected}\n  actual   ${actual}\nThe archive is corrupt or was replaced without updating its checksum.`);
  process.exit(1);
}
console.log(`verified ${path.relative(root, archive)} (sha256 ${actual.slice(0, 12)}…)`);

if (fs.existsSync(target)) {
  if (force !== true) {
    console.log('node_modules already exists; nothing to do (pass --force to replace it).');
    process.exit(0);
  }
  console.log('removing the existing node_modules…');
  fs.rmSync(target, { recursive: true, force: true });
}

console.log('extracting…');
const result = spawnSync('tar', ['-xzf', archive, '-C', root], { stdio: 'inherit' });
if (result.error !== undefined) {
  console.error(`install-offline: tar could not start (${result.error.message}). Extract ${path.relative(root, archive)} into this folder manually.`);
  process.exitCode = 1;
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`install-offline: tar exited with ${String(result.status)}.`);
  process.exitCode = 1;
  process.exit(1);
}

const probes = [
  'node_modules/confluence-cli/bin/index.js',
  'node_modules/confluence-cli/lib/pi/operation-policy.js',
  'node_modules/@deepseek-ai/schemastery/package.json',
];
const missing = probes.filter(probe => fs.existsSync(path.join(root, probe)) === false);
if (missing.length > 0) {
  fail(`extraction finished but these are missing: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('');
console.log('Dependencies are in place. Next:');
console.log('  1. In DSH, add THIS DIRECTORY as a plugin (local directory install), not the git URL.');
console.log('  2. Open Settings → Confluence and fill in the site and credentials, or set CONFLUENCE_* variables.');
console.log('  3. Click "Test connection" once the values are in.');
