'use strict';

/**
 * Resolves one plugin row's `config` plus the harness environment into the
 * settings the tool set needs: the CLI child environment, the write policy
 * (fail-closed allowlist), the approval mode, and the JavaScript runtime used
 * to execute the CLI.
 *
 * Policy precedence, highest first: plugin-row config, the process
 * environment, then the CLI's own defaults. Writes stay disabled unless both
 * an explicit enable and at least one allowed space key resolve.
 */

const path = require('node:path');

/**
 * Editable connection fields, forwarded to the CLI as environment names. A
 * flat row field wins over the same field inside a nested `confluence` object,
 * so the settings page can keep writing flat keys while older patches keep
 * working.
 */
const CONFLUENCE_FIELDS = Object.freeze({
  siteUrl: 'CONFLUENCE_SITE_URL',
  domain: 'CONFLUENCE_DOMAIN',
  apiPath: 'CONFLUENCE_API_PATH',
  authType: 'CONFLUENCE_AUTH_TYPE',
  email: 'CONFLUENCE_EMAIL',
  username: 'CONFLUENCE_USERNAME',
  profile: 'CONFLUENCE_PROFILE',
  protocol: 'CONFLUENCE_PROTOCOL',
  linkStyle: 'CONFLUENCE_LINK_STYLE',
  plantumlFormat: 'CONFLUENCE_PLANTUML_FORMAT',
  forceCloud: 'CONFLUENCE_FORCE_CLOUD',
  token: 'CONFLUENCE_API_TOKEN',
});

const DEFAULT_PREFLIGHT_TTL_MS = 300_000;

const TRUTHY = Object.freeze(['true', '1', 'yes', 'on']);

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Read a boolean setting from row config or an environment value.
 * @param {unknown} value - candidate value.
 * @returns {boolean|undefined} parsed boolean, or undefined when unset.
 */
function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (hasText(value)) return TRUTHY.includes(String(value).trim().toLowerCase());
  return undefined;
}

function normalizeSpaces(value) {
  const entries = Array.isArray(value)
    ? value
    : (hasText(value) ? String(value).split(',') : []);
  const spaces = new Set();
  let valid = true;

  for (const entry of entries) {
    const token = String(entry).trim().toUpperCase();
    if (token === '') continue;
    if (/[*?]/.test(token)) {
      valid = false;
      continue;
    }
    spaces.add(token);
  }

  return { spaces, valid };
}

function assignIfText(target, key, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'object') return;
  if (String(value).trim() === '') return;
  target[key] = String(value);
}

/**
 * Fill what confluence-cli needs from a site URL.
 *
 * The CLI only takes its environment path when `CONFLUENCE_DOMAIN` is present,
 * so a site URL on its own would silently fall back to a config file. Derive the
 * host name from the URL — and, when the URL carries a path, the REST base path
 * — so "site URL + token" is a complete configuration. An explicit host name or
 * API path always wins.
 * @param {Record<string, string|undefined>} cliEnv - environment handed to the CLI, edited in place.
 */
function deriveFromSiteUrl(cliEnv) {
  const rawUrl = cliEnv.CONFLUENCE_SITE_URL;
  if (hasText(rawUrl) === false) return;

  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return;
  }

  if (hasText(cliEnv.CONFLUENCE_DOMAIN) === false && url.hostname !== '') {
    cliEnv.CONFLUENCE_DOMAIN = url.hostname;
  }

  if (hasText(cliEnv.CONFLUENCE_API_PATH)) return;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') {
    // No path in the URL: the CLI infers the base path from the host name.
    return;
  }
  cliEnv.CONFLUENCE_API_PATH = path.endsWith('/rest/api') ? path : `${path}/rest/api`;
}

/**
 * Resolve the effective plugin settings.
 * @param {object} rawConfig - the plugin row's `config` object.
 * @param {NodeJS.ProcessEnv} env - the harness process environment.
 * @param {object} engine - loaded CLI engine (`authorization` supplies defaults).
 * @param {string} [fallbackDirectory] - directory used when a call has no session working directory.
 * @returns {object} resolved settings, write policy, and operator-facing notes.
 */
function resolveConfig(rawConfig, env = process.env, engine, fallbackDirectory) {
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
  const notes = [];

  const connection = config.confluence !== null && typeof config.confluence === 'object'
    ? config.confluence
    : {};
  const cliEnv = { ...env };
  for (const [field, envName] of Object.entries(CONFLUENCE_FIELDS)) {
    assignIfText(cliEnv, envName, connection[field]);
  }
  for (const [field, envName] of Object.entries(CONFLUENCE_FIELDS)) {
    assignIfText(cliEnv, envName, config[field]);
  }
  if (config.env !== null && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env)) {
      assignIfText(cliEnv, key, value);
    }
  }
  deriveFromSiteUrl(cliEnv);

  const envPolicy = engine.authorization.readWriteConfig(cliEnv);
  const explicitWrites = asBoolean(config.writes);
  const configuredSpaces = config.spaces === undefined || config.spaces === null
    ? undefined
    : normalizeSpaces(config.spaces);
  const spaces = configuredSpaces === undefined
    ? { spaces: new Set(envPolicy.spaces), valid: true }
    : configuredSpaces;

  let enabled = explicitWrites === undefined ? envPolicy.enabled : explicitWrites;
  if (asBoolean(cliEnv.CONFLUENCE_READ_ONLY) === true) {
    enabled = false;
    notes.push('CONFLUENCE_READ_ONLY is set: write tools are not registered.');
  }
  if (enabled && !spaces.valid) {
    enabled = false;
    notes.push('Write tools need `spaces` (or CONFLUENCE_PI_WRITE_SPACES) without wildcards: they are not registered.');
  }
  if (enabled && spaces.spaces.size === 0) {
    enabled = false;
    notes.push('Write tools need at least one allowed space key: they are not registered.');
  }

  let limits = envPolicy.limits;
  if (!envPolicy.limitsValid) {
    limits = engine.authorization.DEFAULT_LIMITS;
    notes.push('CONFLUENCE_PI_MAX_* payload limits are invalid: defaults are used.');
  }

  const ttl = Number(config.preflightTtlMs);
  const preflightTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PREFLIGHT_TTL_MS;

  const execPath = hasText(config.nodePath)
    ? path.resolve(String(config.nodePath))
    : (hasText(cliEnv.DSH_NODE_EXECUTABLE) ? cliEnv.DSH_NODE_EXECUTABLE : process.execPath);
  // A DSH Desktop host runs on Electron, where the CLI must start as Node.
  const extraEnv = { ELECTRON_RUN_AS_NODE: '1' };
  if (hasText(env.SystemRoot)) {
    extraEnv.SystemRoot = env.SystemRoot;
  }

  const resolvedDirectory = hasText(config.workingDirectory)
    ? path.resolve(String(config.workingDirectory))
    : (hasText(fallbackDirectory) ? path.resolve(fallbackDirectory) : process.cwd());

  return Object.freeze({
    cliEnv,
    confirm: config.confirm === 'never' ? 'never' : 'ask',
    execPath,
    extraEnv: Object.freeze(extraEnv),
    fallbackDirectory: resolvedDirectory,
    notes: Object.freeze(notes),
    preflightTtlMs,
    skillEnabled: asBoolean(config.skill) !== false,
    writes: Object.freeze({
      enabled,
      limits,
      spaces: new Set(spaces.spaces),
    }),
  });
}

module.exports = {
  CONFLUENCE_FIELDS,
  DEFAULT_PREFLIGHT_TTL_MS,
  asBoolean,
  deriveFromSiteUrl,
  normalizeSpaces,
  resolveConfig,
};
