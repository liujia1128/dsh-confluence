'use strict';

/**
 * Bundle orchestration: resolves configuration, loads the confluence-cli
 * engine, registers the `confluence_*` tools on the calling context, and
 * contributes the `confluence` skill.
 *
 * Nothing here keeps its own state beyond one process-local preflight store,
 * so a plugin reload re-registers a clean surface.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { loadEngine, resolvePackageRoot } = require('./engine.cjs');
const { resolveConfig } = require('./config.cjs');
const { buildToolDefinitions } = require('./tools.cjs');
const { createSettingsServer } = require('./settings-route.cjs');

const SKILL_FILE = path.resolve(__dirname, '..', 'SKILL.md');

/** The settings namespace this plugin's schema is registered under. */
const SETTINGS_NAMESPACE = 'confluence';

const SKILL_DESCRIPTION = 'Read, search, create, update, move, delete, export, or comment on Atlassian Confluence content through the confluence_* tools.';

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function createLogger(ctx) {
  const logger = ctx !== null && ctx !== undefined ? ctx.logger : undefined;
  return {
    info: message => (logger && typeof logger.info === 'function' ? logger.info(message) : undefined),
    warn: message => (logger && typeof logger.warn === 'function' ? logger.warn(message) : undefined),
  };
}

function createCliRunner(engine, config) {
  return function runCli(options) {
    return engine.runner.runCommand({
      packageRoot: engine.packageRoot,
      projectRoot: options.projectRoot,
      args: options.args,
      env: config.cliEnv,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      expectJson: options.expectJson,
      mutation: options.mutation,
      execPath: config.execPath,
      extraEnv: config.extraEnv,
    });
  };
}

/**
 * Resolve the directory that bounds every local file a call may read or write.
 * The session's effective working directory wins, so a DSH workspace setting
 * and the CLI's project-path checks agree.
 */
function createProjectRootResolver(ctx, config) {
  return function projectRoot(exec) {
    const session = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent.session : undefined;
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;

    if (workingDirectory !== undefined && session !== undefined) {
      try {
        const directory = workingDirectory.get(session);
        if (hasText(directory)) {
          return path.resolve(directory);
        }
      } catch {
        // A session without a recorded directory falls through to its header.
      }
    }

    const headerDirectory = session !== null && session !== undefined && session.header !== undefined
      ? session.header.cwd
      : undefined;
    if (hasText(headerDirectory)) {
      return path.resolve(headerDirectory);
    }

    return path.resolve(config.fallbackDirectory);
  };
}

/**
 * Approve one write through the harness approval channel.
 *
 * The preflight summary becomes the audited reason, so the human sees the
 * resolved page title, id, and space rather than raw arguments. `allowed-once`
 * is the only grant; every other outcome fails the call without mutating.
 */
function createApprover(ctx, config) {
  return async function approve(options) {
    if (config.confirm !== 'ask') {
      return;
    }

    const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined;
    if (approval === undefined) {
      throw makeError(
        'APPROVAL_UNAVAILABLE',
        'Confluence writes need an approval channel, and this deployment composes none. '
        + 'Set `confirm: never` on the confluence plugin row to write without an interactive confirmation.',
      );
    }
    if (options.exec.agent === undefined) {
      throw makeError('APPROVAL_UNAVAILABLE', 'Confluence writes need an agent session to route approval through.');
    }

    const reason = [
      hasText(options.title) ? options.title : `Confluence ${options.operation}`,
      options.summary,
      hasText(options.phrase) ? `Confirmation phrase: ${options.phrase}` : undefined,
    ].filter(hasText).join('\n');

    const outcome = await approval.request({
      agent: options.exec.agent,
      toolName: options.exec.name,
      callId: options.exec.callId,
      reason,
      signal: options.exec.signal,
    });

    if (outcome === 'allowed-once') {
      return;
    }

    const denial = outcome === 'rejected'
      ? ['APPROVAL_REJECTED', 'The user rejected this Confluence write.']
      : outcome === 'cancelled'
        ? ['APPROVAL_CANCELLED', 'The approval request was cancelled; nothing was written.']
        : ['APPROVAL_UNAVAILABLE', 'No approval answerer was available, so nothing was written.'];
    throw makeError(denial[0], denial[1]);
  };
}

function describeSkill(config) {
  return config.writes.enabled
    ? SKILL_DESCRIPTION
    : `${SKILL_DESCRIPTION} Read-only profile: the write tools are not registered.`;
}

function registerSkill(ctx, config, logger) {
  if (!config.skillEnabled) {
    return;
  }

  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
  if (skills === undefined) {
    logger.warn('[confluence] no skills service is composed: the confluence skill is not registered.');
    return;
  }

  let content;
  try {
    content = fs.readFileSync(SKILL_FILE, 'utf8');
  } catch (error) {
    logger.warn(`[confluence] cannot read ${SKILL_FILE}: ${error.message}`);
    return;
  }

  const skill = {
    name: 'confluence',
    description: describeSkill(config),
    content,
    source: 'custom',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: path.dirname(SKILL_FILE) },
  };

  ctx.effect(() => {
    try {
      return skills.register(skill);
    } catch (error) {
      logger.warn(`[confluence] skill registration failed: ${error.message}`);
      return () => {};
    }
  });
}

/**
 * Plugin entry point.
 * @param {object} ctx - the plugin's Cordis context.
 * @param {object} [rawConfig] - the plugin row's `config`.
 * @returns {Promise<void>} resolves once the surface is registered.
 */
async function apply(ctx, rawConfig) {
  const logger = createLogger(ctx);
  const configuredRoot = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig.packageRoot : undefined;
  const packageRoot = resolvePackageRoot(configuredRoot, process.env);
  const engine = loadEngine(packageRoot);
  const config = resolveConfig(rawConfig, process.env, engine);

  for (const note of config.notes) {
    logger.warn(`[confluence] ${note}`);
  }

  const store = engine.store.createPreflightStore({
    now: () => Date.now(),
    randomId: () => randomUUID(),
    ttlMs: config.preflightTtlMs,
  });

  const dependencies = {
    approve: createApprover(ctx, config),
    config,
    engine,
    projectRoot: createProjectRootResolver(ctx, config),
    runCli: createCliRunner(engine, config),
    store,
  };

  const definitions = buildToolDefinitions(dependencies);

  ctx.effect(() => {
    const disposers = definitions.map(definition => ctx.tools.register(definition));
    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  });

  registerSkill(ctx, config, logger);

  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  if (settings !== undefined && typeof settings.configure === 'function') {
    try {
      // The bundle ships its own Confluence page; a generated form beside it
      // would edit the same row twice.
      settings.configure({ auto: false });
    } catch (error) {
      logger.warn(`[confluence] cannot take over the generated settings page: ${error.message}`);
    }
  }

  const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;

  ctx.effect(() => createSettingsServer({
    ctx,
    connection: typeof ctx.get === 'function' ? ctx.get('connection') : undefined,
    editor,
    env: config.cliEnv,
    liveStatus: () => ({
      tools: definitions.length,
      writes: config.writes.enabled,
      spaces: [...config.writes.spaces],
      confirm: config.confirm,
      skill: config.skillEnabled,
      packageRoot,
      execPath: config.execPath,
      notes: config.notes,
    }),
    logger,
    probe: () => probeConnection(dependencies),
  }));

  logger.info(
    `[confluence] ${definitions.length} tools registered from ${packageRoot} `
    + `(writes ${config.writes.enabled ? `enabled for ${[...config.writes.spaces].join(', ')}` : 'disabled'}).`,
  );
}

/**
 * Run one cheap read against the live configuration so the settings page can
 * report whether the stored connection actually works.
 * @param {object} dependencies - resolved tool dependencies.
 * @returns {Promise<object>} space count and a short sample.
 */
async function probeConnection(dependencies) {
  const operation = dependencies.engine.policy.getOperation('confluence_spaces');
  const result = await dependencies.runCli({
    projectRoot: dependencies.config.fallbackDirectory,
    args: dependencies.engine.policy.buildArgs('confluence_spaces', { limit: 1 }),
    signal: undefined,
    timeoutMs: 20_000,
    maxOutputBytes: operation.maxOutputBytes,
    expectJson: true,
    mutation: false,
  });

  const spaces = Array.isArray(result.json?.spaces) ? result.json.spaces : [];
  return {
    count: Number(result.json?.spaceCount ?? spaces.length),
    sample: spaces.slice(0, 5).map(space => space?.key ?? space?.name).filter(Boolean),
    message: `连接成功，读到 ${Number(result.json?.spaceCount ?? spaces.length)} 个空间`,
  };
}

module.exports = {
  SETTINGS_NAMESPACE,
  SKILL_DESCRIPTION,
  SKILL_FILE,
  apply,
  createApprover,
  createCliRunner,
  createProjectRootResolver,
  describeSkill,
  probeConnection,
  registerSkill,
};
