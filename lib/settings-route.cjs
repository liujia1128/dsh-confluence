'use strict';

/**
 * Host routes behind the Confluence settings page.
 *
 * The page is a browser document, so it reaches the Host over three same-origin
 * routes: read the effective configuration, write the editable fields through
 * `configEditor` (which persists the profile patch row and reconciles the
 * loader, so a save applies without a restart), and try the CLI once against
 * the values in force.
 *
 * Every route requires the page's own request header and a loopback `Host`; a
 * cross-site form post cannot set either, and requests without the header are
 * refused before any handler runs.
 */

const BASE_PATH = '/dsh-confluence';

/** A same-origin page sets this itself; a cross-site form post cannot. */
const REQUEST_HEADER = 'x-dsh-confluence';

const MAX_BODY_BYTES = 64 * 1024;

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?$/;

/** The row this page owns, as the bundle's patch declares it. */
const ROW_ID = 'confluence';

const EDITABLE_TEXT_FIELDS = Object.freeze([
  'siteUrl', 'domain', 'apiPath', 'email', 'username', 'profile',
  'packageRoot', 'nodePath',
]);

const EDITABLE_BOOLEAN_FIELDS = Object.freeze(['writes', 'skill']);

/** Fields the page renders; everything else stays untouched in the row. */
const VISIBLE_FIELDS = Object.freeze([
  'siteUrl', 'domain', 'apiPath', 'authType', 'email', 'username', 'profile',
  'writes', 'spaces', 'confirm',
]);

const AUTH_TYPES = Object.freeze(['basic', 'bearer']);
const CONFIRM_MODES = Object.freeze(['ask', 'never']);
const MIN_PREFLIGHT_TTL_MS = 60_000;

function sendJson(response, status, payload) {
  try {
    if (response.writableEnded === true || response.destroyed === true) return;
    const body = JSON.stringify(payload);
    if (response.headersSent === true) {
      response.end();
      return;
    }
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  } catch {
    try {
      if (response.writableEnded !== true && response.destroyed !== true) response.end();
    } catch {
      /* the socket is already gone */
    }
  }
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(undefined);
      try {
        request.destroy?.();
      } catch {
        /* the request is already gone */
      }
    }, 10_000);
    timer.unref?.();

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        finish({});
        return;
      }
      try {
        finish(JSON.parse(text));
      } catch {
        finish(undefined);
      }
    });
    request.on('error', () => finish(undefined));
  });
}

/**
 * Whether one request may act. The page's header is required, the connection
 * must be loopback, and a present `Origin` must name the same host.
 * @param {object} request - incoming Node request.
 * @returns {boolean} true when the request may reach a handler.
 */
function requestAllowed(request) {
  const header = request?.headers?.[REQUEST_HEADER];
  if (typeof header !== 'string' || header === '') return false;

  const host = typeof request?.headers?.host === 'string' ? request.headers.host.trim().toLowerCase() : '';
  if (LOOPBACK_HOST.test(host) === false) return false;

  const origin = typeof request?.headers?.origin === 'string' ? request.headers.origin.trim().toLowerCase() : '';
  if (origin !== '') {
    const originHost = origin.replace(/^[a-z]+:\/\//, '').split('/')[0];
    if (originHost !== host) return false;
  }

  return true;
}

function methodOf(request) {
  return String(request?.method ?? 'GET').toUpperCase();
}

/** The config row this page owns, from `configEditor.configuration()`. */
function findRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find(row => row?.entry?.options?.id === ROW_ID) ?? undefined;
}

/** The values the page renders: the fields it owns, never the token or `env`. */
function visibleConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const visible = {};
  for (const key of VISIBLE_FIELDS) {
    if (source[key] !== undefined) visible[key] = source[key];
  }
  return visible;
}

/**
 * Whether a token is in force, and where it comes from. The value itself never
 * leaves the Host.
 */
function tokenSource(config, env) {
  if (typeof config?.token === 'string' && config.token.trim() !== '') return 'settings';
  if (typeof env?.CONFLUENCE_API_TOKEN === 'string' && env.CONFLUENCE_API_TOKEN.trim() !== '') return 'environment';
  return 'external';
}

/**
 * Read the configuration the tools actually run with, plus the fields the page
 * may edit.
 * @param {object} deps - editor handle, live status, and environment.
 * @returns {object} state payload.
 */
function readState(deps) {
  if (deps.editor === undefined) {
    return { supported: false, live: deps.liveStatus(), stored: {}, hasToken: false };
  }

  let row;
  try {
    row = findRow(deps.editor.configuration());
  } catch (error) {
    deps.logger.warn(`[confluence] cannot read the configuration rows: ${error?.message ?? error}`);
    return { supported: false, live: deps.liveStatus(), stored: {}, hasToken: false };
  }

  if (row === undefined) {
    return { supported: false, live: deps.liveStatus(), stored: {}, hasToken: false };
  }

  const config = row.entry?.options?.config ?? {};
  const source = tokenSource(config, deps.env);

  return {
    supported: true,
    writable: true,
    ns: ROW_ID,
    stored: visibleConfig(config),
    // The raw override may carry secret values (token); the page only ever
    // renders VISIBLE_FIELDS, so nothing outside that list may leave the Host.
    override: visibleConfig(row.override),
    hasToken: source !== 'external',
    tokenSource: source,
    live: deps.liveStatus(),
  };
}

function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: '补丁必须是一个对象' };
  }

  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (EDITABLE_TEXT_FIELDS.includes(key)) {
      if (value !== null && typeof value !== 'string') return { error: `${key} 必须是字符串` };
      clean[key] = typeof value === 'string' ? value.trim() : '';
      continue;
    }
    if (EDITABLE_BOOLEAN_FIELDS.includes(key)) {
      if (typeof value !== 'boolean') return { error: `${key} 必须是布尔值` };
      clean[key] = value;
      continue;
    }
    if (key === 'spaces') {
      if (!Array.isArray(value)) return { error: 'spaces 必须是数组' };
      const spaces = [];
      for (const entry of value) {
        const token = String(entry).trim().toUpperCase();
        if (token === '') continue;
        if (/[*?]/.test(token)) return { error: 'spaces 不允许通配符' };
        if (/^[A-Z0-9_.-]+$/.test(token) === false) return { error: `空间 key 不合法：${token}` };
        if (spaces.includes(token) === false) spaces.push(token);
      }
      clean.spaces = spaces;
      continue;
    }
    if (key === 'authType') {
      if (AUTH_TYPES.includes(value) === false) return { error: 'authType 只能是 basic 或 bearer' };
      clean.authType = value;
      continue;
    }
    if (key === 'confirm') {
      if (CONFIRM_MODES.includes(value) === false) return { error: 'confirm 只能是 ask 或 never' };
      clean.confirm = value;
      continue;
    }
    if (key === 'preflightTtlMs') {
      const ttl = Number(value);
      if (!Number.isFinite(ttl) || ttl < MIN_PREFLIGHT_TTL_MS) {
        return { error: `preflightTtlMs 不能小于 ${MIN_PREFLIGHT_TTL_MS}` };
      }
      clean.preflightTtlMs = ttl;
      continue;
    }
    if (key === 'token') {
      if (typeof value !== 'string') return { error: 'token 必须是字符串' };
      clean.token = value.trim();
      continue;
    }
    return { error: `未知字段：${key}` };
  }

  return { patch: clean };
}

/**
 * The next raw config for the profile row: what the row already carries in this
 * layer and the layer below, then this patch, with blanked fields removed so the
 * patch stays readable.
 */
function nextConfig(base, patch) {
  const next = { ...(base !== null && typeof base === 'object' ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === '') {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  return next;
}

function createSettingsServer(deps) {
  const server = deps.ctx.get('webServer');
  if (server === undefined || server === null || typeof server.register !== 'function') {
    deps.logger.warn('[confluence] no web server is composed: the settings page cannot reach the host.');
    return () => {};
  }

  const disposers = [];

  const register = (path, handler) => {
    try {
      const dispose = server.register({
        kind: 'exact',
        path: `${BASE_PATH}${path}`,
        handler: (request, response) => {
          try {
            if (requestAllowed(request) === false) {
              sendJson(response, 403, { status: 'forbidden' });
              return;
            }
            Promise.resolve(handler(request, response)).catch((error) => {
              deps.logger.warn(`[confluence] settings route ${path} failed: ${error?.message ?? error}`);
              sendJson(response, 500, { status: 'error', message: String(error?.message ?? error) });
            });
          } catch (error) {
            deps.logger.warn(`[confluence] settings route ${path} failed: ${error?.message ?? error}`);
            sendJson(response, 500, { status: 'error', message: String(error?.message ?? error) });
          }
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      deps.logger.warn(`[confluence] cannot answer ${BASE_PATH}${path}: ${error?.message ?? error}`);
    }
  };

  register('/state', (request, response) => {
    const method = methodOf(request);
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(response, 405, { status: 'method' });
      return;
    }
    sendJson(response, 200, { status: 'ok', ...readState(deps) });
  });

  register('/save', async (request, response) => {
    if (methodOf(request) !== 'POST') {
      sendJson(response, 405, { status: 'method' });
      return;
    }
    if (deps.editor === undefined) {
      sendJson(response, 503, { status: 'unsupported', message: '当前部署没有 configEditor 服务，无法保存。' });
      return;
    }

    const body = await readJsonBody(request);
    if (body === undefined) {
      sendJson(response, 400, { status: 'invalid', message: '请求体不是合法 JSON' });
      return;
    }

    const validated = validatePatch(body.patch);
    if (validated.error !== undefined) {
      sendJson(response, 400, { status: 'invalid', message: validated.error });
      return;
    }

    const row = findRow(deps.editor.configuration());
    if (row === undefined) {
      sendJson(response, 500, { status: 'unsupported', message: `在 profile 配置中找不到行 ${ROW_ID}。` });
      return;
    }

    try {
      const base = { ...(row.inherited ?? {}), ...(row.override ?? {}) };
      const next = nextConfig(base, validated.patch);
      await deps.editor.edit(row.entry, () => next);
    } catch (error) {
      sendJson(response, 409, { status: 'rejected', message: String(error?.message ?? error) });
      return;
    }

    sendJson(response, 200, {
      status: 'saved',
      applied: 'live',
      changed: Object.keys(validated.patch),
      live: deps.liveStatus(),
    });
  });

  register('/test', async (request, response) => {
    if (methodOf(request) !== 'POST') {
      sendJson(response, 405, { status: 'method' });
      return;
    }
    try {
      const result = await deps.probe();
      sendJson(response, 200, { status: 'ok', ...result });
    } catch (error) {
      const detail = [
        String(error?.message ?? error),
        error?.stderr ? `\nstderr:\n${error.stderr}` : '',
        error?.stdout ? `\nstdout:\n${error.stdout}` : '',
      ].join('');
      sendJson(response, 200, {
        status: 'failed',
        message: detail,
        code: typeof error?.code === 'string' ? error.code : 'CLI_FAILED',
      });
    }
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already released */
      }
    }
  };
}

module.exports = {
  BASE_PATH,
  MAX_BODY_BYTES,
  REQUEST_HEADER,
  ROW_ID,
  createSettingsServer,
  findRow,
  nextConfig,
  readState,
  requestAllowed,
  tokenSource,
  validatePatch,
  visibleConfig,
};
