'use strict';

/**
 * Locates a confluence-cli package and loads its Pi engine modules (operation
 * policy, child-process runner, preflight checks, one-use approval store,
 * write-authorization).
 *
 * Resolution order, first hit wins:
 *   1. `config.packageRoot` on the plugin row;
 *   2. `CONFLUENCE_CLI_ROOT` in the environment;
 *   3. `..` twice from this directory — the bundle sitting inside a
 *      confluence-cli checkout, which is how this repository is developed;
 *   4. the `confluence-cli` dependency this package installs for standalone use.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENGINE_MODULES = Object.freeze({
  policy: 'lib/pi/operation-policy.js',
  runner: 'lib/pi/command-runner.js',
  preflight: 'lib/pi/preflight.js',
  store: 'lib/pi/preflight-store.js',
  authorization: 'lib/pi/write-authorization.js',
});

const CLI_ENTRY = 'bin/index.js';

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function candidateRoots(configuredRoot, env) {
  const candidates = [];
  if (hasText(configuredRoot)) {
    candidates.push(path.resolve(configuredRoot));
  }
  if (env !== null && env !== undefined && hasText(env.CONFLUENCE_CLI_ROOT)) {
    candidates.push(path.resolve(env.CONFLUENCE_CLI_ROOT));
  }
  try {
    candidates.push(path.resolve(fs.realpathSync(__dirname), '..', '..'));
  } catch {
    // A missing realpath only removes one candidate; the literal path follows.
  }
  candidates.push(path.resolve(__dirname, '..', '..'));
  try {
    candidates.push(path.dirname(require.resolve('confluence-cli/package.json')));
  } catch {
    // No installed dependency: the other candidates, or the error below, decide.
  }

  return [...new Set(candidates)];
}

function isCliPackageRoot(directory) {
  return fs.existsSync(path.join(directory, CLI_ENTRY))
    && fs.existsSync(path.join(directory, ENGINE_MODULES.policy));
}

/**
 * Resolve the confluence-cli package root.
 * @param {string} [configuredRoot] - `config.packageRoot` from the plugin row.
 * @param {NodeJS.ProcessEnv} [env] - environment read for `CONFLUENCE_CLI_ROOT`.
 * @returns {string} absolute package root that contains `bin/index.js`.
 * @throws {Error} when no candidate directory is a confluence-cli package.
 */
function resolvePackageRoot(configuredRoot, env = process.env) {
  for (const candidate of candidateRoots(configuredRoot, env)) {
    if (isCliPackageRoot(candidate)) {
      return candidate;
    }
  }

  const error = new Error(
    'dsh-plugin-confluence could not find a confluence-cli package. '
    + 'Install its dependencies (npm install), set `packageRoot` on the plugin row, '
    + 'or set CONFLUENCE_CLI_ROOT to a checkout that contains bin/index.js.',
  );
  error.code = 'CLI_NOT_FOUND';
  throw error;
}

/**
 * Load every engine module from one package root.
 * @param {string} packageRoot - resolved confluence-cli root.
 * @returns {object} frozen engine with the loaded modules.
 */
function loadEngine(packageRoot) {
  const loaded = { packageRoot };
  for (const [key, relativePath] of Object.entries(ENGINE_MODULES)) {
    loaded[key] = require(path.join(packageRoot, relativePath));
  }
  return Object.freeze(loaded);
}

module.exports = {
  ENGINE_MODULES,
  candidateRoots,
  isCliPackageRoot,
  loadEngine,
  resolvePackageRoot,
};
