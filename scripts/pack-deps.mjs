#!/usr/bin/env node
/**
 * Rebuilds `deps/node_modules.tar.gz` from `package.json` + `package-lock.json`
 * so a machine without network access can install the runtime dependencies.
 *
 * Only production dependencies are packed (`--omit=dev`), which is what the
 * plugin needs at run time; jest and the rest of the dev tree stay out.
 *
 * Usage: node scripts/pack-deps.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depsDir = path.join(root, 'deps');
const archive = path.join(depsDir, 'node_modules.tar.gz');
const checksum = path.join(depsDir, 'node_modules.sha256');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error !== undefined) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-confluence-deps-'));
try {
  for (const name of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(root, name), path.join(work, name));
  }

  console.log('installing production dependencies…');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work });

  console.log('archiving…');
  run('tar', ['-czf', 'node_modules.tar.gz', 'node_modules'], { cwd: work });

  fs.mkdirSync(depsDir, { recursive: true });
  fs.copyFileSync(path.join(work, 'node_modules.tar.gz'), archive);

  const digest = sha256(archive);
  fs.writeFileSync(checksum, `${digest}  node_modules.tar.gz\n`);

  const megabytes = (fs.statSync(archive).size / (1024 * 1024)).toFixed(2);
  console.log(`wrote ${path.relative(root, archive)} (${megabytes} MB)`);
  console.log(`sha256 ${digest}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
