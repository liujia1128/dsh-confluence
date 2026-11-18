'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateArguments } = require('../lib/args.cjs');
const { asBoolean, normalizeSpaces, resolveConfig } = require('../lib/config.cjs');
const { isCliPackageRoot, loadEngine, resolvePackageRoot } = require('../lib/engine.cjs');
const { TEXT_OUTPUT_SCHEMA, TOOL_SPECS, buildToolDefinitions } = require('../lib/tools.cjs');
const plugin = require('../lib/plugin.cjs');

const DSH_ROOT = path.resolve(__dirname, '..');
const CHECKOUT_ROOT = path.resolve(DSH_ROOT, '..');

const READ_TOOL_NAMES = [
  'confluence_read', 'confluence_search', 'confluence_info', 'confluence_spaces',
  'confluence_children', 'confluence_export', 'confluence_convert', 'confluence_find',
  'confluence_versions', 'confluence_comments', 'confluence_attachments',
  'confluence_property_list', 'confluence_property_get',
];

const WRITE_TOOL_NAMES = [
  'confluence_create', 'confluence_create_child', 'confluence_update', 'confluence_move',
  'confluence_delete', 'confluence_copy_tree_preview', 'confluence_copy_tree',
  'confluence_comment_create', 'confluence_comment_delete', 'confluence_property_set',
  'confluence_property_delete', 'confluence_attachment_upload', 'confluence_attachment_delete',
  'confluence_version_delete', 'confluence_versions_purge_preview', 'confluence_versions_purge',
];

let engine;
let workspace;

beforeAll(() => {
  engine = loadEngine(resolvePackageRoot());
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-confluence-'));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function makeExec(overrides = {}) {
  return {
    name: 'confluence_read',
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: undefined,
    ...overrides,
  };
}

function makeDeps({ writes = false, spaces = [], overrides = {} } = {}) {
  const calls = [];
  const approvals = [];
  const preflightCalls = [];
  const preflight = {
    stableFingerprint: value => JSON.stringify(value),
    runPreflight: jest.fn(async options => {
      preflightCalls.push(options);
      return overrides.preflightResult === undefined
        ? { operation: options.operation, input: options.input, targets: [{ role: 'page', pageId: '42', title: 'Target', spaceKey: 'ENG' }], facts: {}, summary: 'Update Target (42) in ENG', snapshotHash: 'snap-1' }
        : overrides.preflightResult(options);
    }),
  };

  const deps = {
    approve: async options => {
      approvals.push(options);
      if (overrides.approve !== undefined) {
        return overrides.approve(options);
      }
      return undefined;
    },
    config: {
      confirm: 'ask',
      preflightTtlMs: 300_000,
      writes: { enabled: writes, limits: engine.authorization.DEFAULT_LIMITS, spaces: new Set(spaces) },
    },
    engine: {
      authorization: engine.authorization,
      packageRoot: engine.packageRoot,
      policy: engine.policy,
      preflight,
      store: engine.store,
    },
    projectRoot: overrides.projectRoot || (() => workspace),
    runCli: async options => {
      calls.push(options);
      if (overrides.runCli !== undefined) {
        return overrides.runCli(options);
      }
      return { json: { ok: true }, stdout: '{"ok":true}', stderr: '', truncated: false };
    },
    store: engine.store.createPreflightStore({
      now: () => 1_000,
      randomId: () => 'approval-1',
      ttlMs: 300_000,
    }),
  };

  return { approvals, calls, deps, preflightCalls };
}

function definitionFor(deps, name) {
  const definition = buildToolDefinitions(deps).find(entry => entry.name === name);
  if (definition === undefined) {
    throw new Error(`missing definition ${name}`);
  }
  return definition;
}

describe('engine resolution', () => {
  test('resolves a CLI package root that owns bin/index.js', () => {
    const root = resolvePackageRoot();
    expect(isCliPackageRoot(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin', 'index.js'))).toBe(true);
  });

  test('falls back when the configured hint is not a CLI root', () => {
    expect(isCliPackageRoot(DSH_ROOT)).toBe(false);
    expect(resolvePackageRoot(DSH_ROOT)).toBe(resolvePackageRoot());
  });

  test('honours CONFLUENCE_CLI_ROOT', () => {
    const root = resolvePackageRoot(undefined, { CONFLUENCE_CLI_ROOT: resolvePackageRoot() });
    expect(root).toBe(resolvePackageRoot());
  });

  test('uses the surrounding checkout when the bundle lives inside one', () => {
    const root = resolvePackageRoot();
    if (isCliPackageRoot(CHECKOUT_ROOT)) {
      expect(root).toBe(CHECKOUT_ROOT);
      return;
    }
    // Standalone install: the declared dependency supplies the CLI.
    expect(root.split(path.sep).join('/')).toContain('confluence-cli');
  });

  test('loads the shared Pi engine modules', () => {
    expect(typeof engine.policy.buildArgs).toBe('function');
    expect(typeof engine.preflight.runPreflight).toBe('function');
    expect(typeof engine.authorization.assertAllowedSpaces).toBe('function');
  });
});

describe('configuration', () => {
  test('keeps writes disabled by default', () => {
    const config = resolveConfig({}, {}, engine);
    expect(config.writes.enabled).toBe(false);
    expect(config.confirm).toBe('ask');
    expect(config.skillEnabled).toBe(true);
    expect(config.execPath).toBeTruthy();
  });

  test('enables writes only with an explicit flag and spaces', () => {
    const config = resolveConfig({ writes: true, spaces: ['eng', ' docs '] }, {}, engine);
    expect(config.writes.enabled).toBe(true);
    expect([...config.writes.spaces]).toEqual(['ENG', 'DOCS']);
  });

  test('refuses wildcard space allowlists', () => {
    const config = resolveConfig({ writes: true, spaces: ['ENG*'] }, {}, engine);
    expect(config.writes.enabled).toBe(false);
    expect(config.notes.join(' ')).toMatch(/without wildcards/);
  });

  test('refuses writes without any space key', () => {
    const config = resolveConfig({ writes: true }, {}, engine);
    expect(config.writes.enabled).toBe(false);
    expect(config.notes.join(' ')).toMatch(/at least one allowed space/);
  });

  test('honours CONFLUENCE_READ_ONLY over the row config', () => {
    const config = resolveConfig({ writes: true, spaces: ['ENG'] }, { CONFLUENCE_READ_ONLY: 'true' }, engine);
    expect(config.writes.enabled).toBe(false);
    expect(config.notes.join(' ')).toMatch(/CONFLUENCE_READ_ONLY/);
  });

  test('inherits writes from the Pi environment variables', () => {
    const config = resolveConfig({}, { CONFLUENCE_PI_WRITES: 'true', CONFLUENCE_PI_WRITE_SPACES: 'ENG' }, engine);
    expect(config.writes.enabled).toBe(true);
    expect(config.writes.spaces.has('ENG')).toBe(true);
  });

  test('maps row connection fields to CLI environment names', () => {
    const config = resolveConfig({
      confluence: { domain: 'example.atlassian.net', apiPath: '/wiki/rest/api', authType: 'basic', email: 'a@b.c' },
      env: { CONFLUENCE_API_TOKEN: 'token-1' },
    }, {}, engine);
    expect(config.cliEnv.CONFLUENCE_DOMAIN).toBe('example.atlassian.net');
    expect(config.cliEnv.CONFLUENCE_API_PATH).toBe('/wiki/rest/api');
    expect(config.cliEnv.CONFLUENCE_API_TOKEN).toBe('token-1');
  });

  test('forwards the settings-page token and prefers flat fields', () => {
    const config = resolveConfig({
      token: 'page-token',
      siteUrl: 'https://flat.example.com/wiki',
      confluence: { siteUrl: 'https://nested.example.com/wiki', domain: 'nested.example.com' },
    }, { CONFLUENCE_API_TOKEN: 'env-token' }, engine);

    expect(config.cliEnv.CONFLUENCE_API_TOKEN).toBe('page-token');
    expect(config.cliEnv.CONFLUENCE_SITE_URL).toBe('https://flat.example.com/wiki');
    expect(config.cliEnv.CONFLUENCE_DOMAIN).toBe('nested.example.com');
  });

  test('derives the host name and API path from a site URL', () => {
    const cloud = resolveConfig({ siteUrl: 'https://company.atlassian.net/wiki', token: 't' }, {}, engine);
    expect(cloud.cliEnv.CONFLUENCE_DOMAIN).toBe('company.atlassian.net');
    expect(cloud.cliEnv.CONFLUENCE_API_PATH).toBe('/wiki/rest/api');

    // No path in the URL: the CLI infers /rest/api from a non-Cloud host.
    const dataCenter = resolveConfig({ siteUrl: 'https://confluence.example.com', token: 't' }, {}, engine);
    expect(dataCenter.cliEnv.CONFLUENCE_DOMAIN).toBe('confluence.example.com');
    expect(dataCenter.cliEnv.CONFLUENCE_API_PATH).toBeUndefined();

    const scoped = resolveConfig({
      siteUrl: 'https://api.atlassian.com/ex/confluence/abc123/wiki', token: 't',
    }, {}, engine);
    expect(scoped.cliEnv.CONFLUENCE_API_PATH).toBe('/ex/confluence/abc123/wiki/rest/api');

    const explicit = resolveConfig({
      siteUrl: 'https://x.example.com/wiki', domain: 'y.example.com', apiPath: '/custom/rest/api',
    }, {}, engine);
    expect(explicit.cliEnv.CONFLUENCE_DOMAIN).toBe('y.example.com');
    expect(explicit.cliEnv.CONFLUENCE_API_PATH).toBe('/custom/rest/api');

    const unparsable = resolveConfig({ siteUrl: 'not a url', token: 't' }, {}, engine);
    expect(unparsable.cliEnv.CONFLUENCE_DOMAIN).toBeUndefined();
  });

  test('accepts never as the approval mode and a custom preflight ttl', () => {
    const config = resolveConfig({ confirm: 'never', preflightTtlMs: 1000 }, {}, engine);
    expect(config.confirm).toBe('never');
    expect(config.preflightTtlMs).toBe(1000);
  });

  test('parses booleans and space lists', () => {
    expect(asBoolean('YES')).toBe(true);
    expect(asBoolean('off')).toBe(false);
    expect(asBoolean(undefined)).toBeUndefined();
    expect([...normalizeSpaces('a, b').spaces]).toEqual(['A', 'B']);
    expect(normalizeSpaces(['A?']).valid).toBe(false);
  });
});

describe('tool surface', () => {
  test('registers only read tools while writes are disabled', () => {
    const { deps } = makeDeps();
    const names = buildToolDefinitions(deps).map(definition => definition.name);
    expect(names).toEqual(READ_TOOL_NAMES);
  });

  test('adds every write tool once writes are enabled', () => {
    const { deps } = makeDeps({ writes: true, spaces: ['ENG'] });
    const names = buildToolDefinitions(deps).map(definition => definition.name);
    expect(names).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
    expect(new Set(names).size).toBe(names.length);
  });

  test('declares registry-ready definitions', () => {
    const { deps } = makeDeps({ writes: true, spaces: ['ENG'] });
    for (const definition of buildToolDefinitions(deps)) {
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.parameters.type).toBe('object');
      expect(definition.parameters.additionalProperties).toBe(false);
      for (const key of definition.parameters.required || []) {
        expect(definition.parameters.properties[key]).toBeDefined();
      }
      expect(typeof definition.execute).toBe('function');
      expect(Number.isFinite(definition.timeoutMs)).toBe(true);
      expect(definition.output.schema).toBe(TEXT_OUTPUT_SCHEMA);
      const content = definition.output.render({}, { text: 'rendered' });
      expect(content).toEqual([{ type: 'text', text: 'rendered' }]);
      const view = definition.presentCall({ pageId: '1' });
      expect(view.card).toBe('generic');
      expect(typeof view.title).toBe('string');
    }
  });

  test('keeps every spec paired with an allowed CLI operation', () => {
    for (const spec of TOOL_SPECS) {
      expect(Boolean(spec.write)).toBe(!READ_TOOL_NAMES.includes(spec.name));
      expect(() => engine.policy.buildArgs(spec.name, {})).not.toThrow(TypeError);
    }
  });
});

describe('argument validation', () => {
  const readParameters = TOOL_SPECS.find(spec => spec.name === 'confluence_read').parameters;

  test('accepts a minimal valid call', () => {
    expect(validateArguments(readParameters, { pageId: '123' })).toEqual([]);
  });

  test('reports a missing required parameter', () => {
    expect(validateArguments(readParameters, {})).toEqual(['pageId is required']);
  });

  test('reports a blank required parameter', () => {
    expect(validateArguments(readParameters, { pageId: '  ' })).toEqual(['pageId is required']);
  });

  test('reports an unsupported parameter', () => {
    expect(validateArguments(readParameters, { pageId: '1', nope: true })).toEqual(['nope is not a supported parameter']);
  });

  test('reports a wrong type and a bad enum value', () => {
    expect(validateArguments(readParameters, { pageId: 5 })).toEqual(['pageId must be a string, got number 5']);
    expect(validateArguments(readParameters, { pageId: '1', format: 'pdf' })).toEqual([
      'format must be one of "text", "markdown", "storage", "html"',
    ]);
  });

  test('validates nested arrays', () => {
    const upload = TOOL_SPECS.find(spec => spec.name === 'confluence_attachment_upload').parameters;
    expect(validateArguments(upload, { pageId: '1', files: ['a.txt', 'b.txt'] })).toEqual([]);
    expect(validateArguments(upload, { pageId: '1', files: [1] })).toEqual(['files[0] must be a string, got number 1']);
  });
});

describe('read execution', () => {
  test('builds the matching CLI arguments and marks content untrusted', async () => {
    const { calls, deps } = makeDeps();
    const result = await definitionFor(deps, 'confluence_read').execute(
      { pageId: '123', format: 'markdown' },
      makeExec({ name: 'confluence_read' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['read', '123', '--format', 'markdown']);
    expect(calls[0].expectJson).toBe(false);
    expect(calls[0].mutation).toBe(false);
    expect(result.text).toContain('Untrusted Confluence content');
    expect(result.text).toContain('{"ok":true}');
  });

  test('surfaces output truncation', async () => {
    const { deps } = makeDeps({ overrides: { runCli: async () => ({ stdout: 'partial', stderr: '', truncated: true }) } });
    const result = await definitionFor(deps, 'confluence_read').execute({ pageId: '1' }, makeExec());
    expect(result.truncated).toBe(true);
  });

  test('rejects invalid arguments before running the CLI', async () => {
    const { calls, deps } = makeDeps();
    await expect(definitionFor(deps, 'confluence_info').execute({}, makeExec())).rejects.toThrow(/pageId is required/);
    expect(calls).toHaveLength(0);
  });

  test('bounds export destinations to the session directory', async () => {
    const { calls, deps } = makeDeps();
    await expect(definitionFor(deps, 'confluence_export').execute(
      { pageId: '1', destination: '../escape' },
      makeExec(),
    )).rejects.toThrow(/inside the project directory/);
    expect(calls).toHaveLength(0);

    const ok = await definitionFor(deps, 'confluence_export').execute(
      { pageId: '1', destination: '.', file: 'page.md' },
      makeExec(),
    );
    expect(ok.text).toContain('{"ok":true}');
    expect(calls[0].args).toContain('--dest');
  });

  test('rejects export filenames with path separators', async () => {
    const { deps } = makeDeps();
    await expect(definitionFor(deps, 'confluence_export').execute(
      { pageId: '1', destination: '.', file: 'nested/page.md' },
      makeExec(),
    )).rejects.toThrow(/simple basename/);
  });

  test('requires a destination when downloading attachments', async () => {
    const { calls, deps } = makeDeps();
    await expect(definitionFor(deps, 'confluence_attachments').execute(
      { pageId: '1', download: true },
      makeExec({ name: 'confluence_attachments' }),
    )).rejects.toMatchObject({
      code: 'INVALID_ARGUMENTS',
      message: expect.stringContaining('destination is required'),
    });
    expect(calls).toHaveLength(0);
  });
});

describe('write execution', () => {
  test('runs preflight, approval, then the mutation', async () => {
    const { approvals, calls, deps, preflightCalls } = makeDeps({ writes: true, spaces: ['ENG'] });
    const result = await definitionFor(deps, 'confluence_update').execute(
      { pageId: '42', title: 'Target' },
      makeExec({ name: 'confluence_update' }),
    );

    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0].operation).toBe('confluence_update');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].title).toBe('Update Confluence page');
    expect(approvals[0].summary).toContain('Update Target (42)');
    expect(calls).toHaveLength(1);
    expect(calls[0].mutation).toBe(true);
    expect(calls[0].args).toEqual(['--json', 'update', '42', '--title', 'Target', '--format', 'storage']);
    expect(result.text).toContain('Untrusted Confluence content');
  });

  test('refuses a body file that changed while approval was open', async () => {
    const bodyFile = path.join(workspace, 'body.md');
    fs.writeFileSync(bodyFile, '# before');

    const { calls, deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        approve: async () => {
          // The human answered while the file was being edited.
          fs.writeFileSync(bodyFile, '# after');
        },
      },
    });

    await expect(definitionFor(deps, 'confluence_create').execute(
      { title: 'New page', spaceKey: 'ENG', contentFile: bodyFile },
      makeExec({ name: 'confluence_create' }),
    )).rejects.toMatchObject({ code: 'STALE_FILE' });
    expect(calls).toHaveLength(0);
  });

  test('rejects a target space outside the allowlist before approval', async () => {
    const { approvals, calls, deps } = makeDeps({ writes: true, spaces: ['OTHER'] });
    await expect(definitionFor(deps, 'confluence_update').execute(
      { pageId: '42', title: 'Target' },
      makeExec({ name: 'confluence_update' }),
    )).rejects.toThrow(/not allowed/);
    expect(approvals).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('stops when approval is rejected', async () => {
    const { calls, deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        approve: async () => {
          const error = new Error('The user rejected this Confluence write.');
          error.code = 'APPROVAL_REJECTED';
          throw error;
        },
      },
    });
    await expect(definitionFor(deps, 'confluence_delete').execute(
      { pageId: '42' },
      makeExec({ name: 'confluence_delete' }),
    )).rejects.toThrow(/rejected/);
    expect(calls).toHaveLength(0);
  });

  test('reports an unknown mutation result instead of a plain failure', async () => {
    const { deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        runCli: async options => {
          if (options.mutation) {
            const error = new Error('Confluence CLI mutation result is unknown because execution timed out.');
            error.code = 'UNKNOWN_RESULT';
            error.unknownResult = true;
            throw error;
          }
          return { json: {}, stdout: '{}', stderr: '', truncated: false };
        },
      },
    });
    await expect(definitionFor(deps, 'confluence_update').execute(
      { pageId: '42', title: 'Target' },
      makeExec({ name: 'confluence_update' }),
    )).rejects.toThrow(/result is unknown/);
  });

  test('requires a body or title for updates', async () => {
    const { deps } = makeDeps({ writes: true, spaces: ['ENG'] });
    await expect(definitionFor(deps, 'confluence_update').execute(
      { pageId: '42' },
      makeExec({ name: 'confluence_update' }),
    )).rejects.toThrow(/At least one of title/);
  });

  test('issues a one-use approval id for a bulk preview', async () => {
    const { deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        preflightResult: options => ({
          operation: options.operation,
          input: options.input,
          targets: [{ role: 'page', pageId: '7', title: 'Root', spaceKey: 'ENG' }],
          facts: { totalCreateCount: 3 },
          summary: 'Copy 3 pages under 9',
          phrase: 'copy 3 pages',
          snapshotHash: 'snap-2',
        }),
      },
    });

    const result = await definitionFor(deps, 'confluence_copy_tree_preview').execute(
      { sourcePageId: '7', targetParentId: '9' },
      makeExec({ name: 'confluence_copy_tree_preview' }),
    );

    expect(result.text).toContain('Copy 3 pages under 9');
    expect(result.text).toContain('Approval ID: approval-1');
    expect(result.text).toContain('expires in 5 minutes');
    expect(deps.store.size()).toBe(1);
  });

  test('executes a bulk operation only through its approval id', async () => {
    const { approvals, calls, deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        preflightResult: options => ({
          operation: options.operation,
          input: options.input,
          targets: [{ role: 'page', pageId: '7', title: 'Root', spaceKey: 'ENG' }],
          facts: { totalCreateCount: 2 },
          summary: 'Copy 2 pages',
          snapshotHash: 'snap-3',
        }),
      },
    });

    await definitionFor(deps, 'confluence_copy_tree_preview').execute(
      { sourcePageId: '7', targetParentId: '9' },
      makeExec({ name: 'confluence_copy_tree_preview' }),
    );

    const result = await definitionFor(deps, 'confluence_copy_tree').execute(
      { approvalId: 'approval-1' },
      makeExec({ name: 'confluence_copy_tree' }),
    );

    expect(result.text).toContain('Untrusted Confluence content');
    expect(approvals).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].mutation).toBe(true);
    expect(calls[0].args.slice(0, 4)).toEqual(['--json', 'copy-tree', '7', '9']);

    await expect(definitionFor(deps, 'confluence_copy_tree').execute(
      { approvalId: 'approval-1' },
      makeExec({ name: 'confluence_copy_tree' }),
    )).rejects.toThrow(/Unknown or used approval/);
  });

  test('rejects a bulk plan that changed after approval', async () => {
    let planCount = 2;
    const { calls, deps } = makeDeps({
      writes: true,
      spaces: ['ENG'],
      overrides: {
        preflightResult: options => ({
          operation: options.operation,
          input: options.input,
          targets: [{ role: 'page', pageId: '7', title: 'Root', spaceKey: 'ENG' }],
          facts: { totalCreateCount: planCount },
          summary: `Copy ${planCount} pages`,
          snapshotHash: `snap-${planCount}`,
        }),
      },
    });

    await definitionFor(deps, 'confluence_copy_tree_preview').execute(
      { sourcePageId: '7', targetParentId: '9' },
      makeExec({ name: 'confluence_copy_tree_preview' }),
    );
    planCount = 5;

    await expect(definitionFor(deps, 'confluence_copy_tree').execute(
      { approvalId: 'approval-1' },
      makeExec({ name: 'confluence_copy_tree' }),
    )).rejects.toThrow(/no longer matches/);
    expect(calls).toHaveLength(0);
  });

  test('requires a body for page creation', async () => {
    const { deps } = makeDeps({ writes: true, spaces: ['ENG'] });
    await expect(definitionFor(deps, 'confluence_create').execute(
      { title: 'New page', spaceKey: 'ENG' },
      makeExec({ name: 'confluence_create' }),
    )).rejects.toThrow(/content or contentFile/);
  });

  test('accepts a folder without a body', async () => {
    const { calls, deps } = makeDeps({ writes: true, spaces: ['ENG'] });
    await definitionFor(deps, 'confluence_create').execute(
      { title: 'New folder', spaceKey: 'ENG', type: 'folder' },
      makeExec({ name: 'confluence_create' }),
    );
    expect(calls[0].args).toContain('--type');
    expect(calls[0].args).not.toContain('--content');
  });
});

describe('host wiring', () => {
  function fakeCtx(services) {
    const registered = [];
    return {
      effect: callback => {
        const dispose = callback();
        return dispose;
      },
      get: name => services[name],
      logger: { info: () => {}, warn: () => {} },
      tools: { register: definition => { registered.push(definition); return () => {}; } },
      registered,
    };
  }

  test('resolves the project root from the session working directory first', () => {
    const resolve = plugin.createProjectRootResolver(
      { get: name => (name === 'workingDirectory' ? { get: () => '/tmp/one' } : undefined) },
      { fallbackDirectory: '/tmp/fallback' },
    );
    expect(resolve({ agent: { session: { header: { cwd: '/tmp/two' } } } })).toBe(path.resolve('/tmp/one'));

    const fromHeader = plugin.createProjectRootResolver(
      { get: () => undefined },
      { fallbackDirectory: '/tmp/fallback' },
    );
    expect(fromHeader({ agent: { session: { header: { cwd: '/tmp/two' } } } })).toBe(path.resolve('/tmp/two'));
    expect(fromHeader(undefined)).toBe(path.resolve('/tmp/fallback'));
  });

  test('skips the approval channel when confirm is never', async () => {
    const approve = plugin.createApprover({ get: () => { throw new Error('should not be asked'); } }, { confirm: 'never' });
    await expect(approve({ exec: makeExec(), operation: 'confluence_delete', summary: 'x' })).resolves.toBeUndefined();
  });

  test('turns a rejected approval into a coded error', async () => {
    const approve = plugin.createApprover(
      { get: () => ({ request: async () => 'rejected' }) },
      { confirm: 'ask' },
    );
    await expect(approve({
      exec: makeExec({ agent: { id: 'agent-1' } }),
      operation: 'confluence_delete',
      summary: 'Delete Target (42) in ENG',
    })).rejects.toMatchObject({ code: 'APPROVAL_REJECTED' });
  });

  test('passes the preflight summary as the approval reason', async () => {
    const requests = [];
    const approve = plugin.createApprover(
      { get: () => ({ request: async request => { requests.push(request); return 'allowed-once'; } }) },
      { confirm: 'ask' },
    );
    await approve({
      exec: makeExec({ agent: { id: 'agent-1' } }),
      operation: 'confluence_delete',
      summary: 'Delete Target (42) in ENG',
      phrase: 'delete 42',
    });
    expect(requests[0].toolName).toBe('confluence_read');
    expect(requests[0].reason).toContain('Delete Target (42) in ENG');
    expect(requests[0].reason).toContain('Confirmation phrase: delete 42');
  });

  test('fails closed without an approval service', async () => {
    const approve = plugin.createApprover({ get: () => undefined }, { confirm: 'ask' });
    await expect(approve({
      exec: makeExec({ agent: { id: 'agent-1' } }),
      operation: 'confluence_delete',
      summary: 'x',
    })).rejects.toMatchObject({ code: 'APPROVAL_UNAVAILABLE' });
  });

  test('registers tools and the skill on activation', async () => {
    const skills = { register: jest.fn(() => () => {}) };
    const ctx = fakeCtx({ skills });
    await plugin.apply(ctx, {});

    expect(ctx.registered.map(definition => definition.name)).toEqual(READ_TOOL_NAMES);
    expect(skills.register).toHaveBeenCalledTimes(1);
    const skill = skills.register.mock.calls[0][0];
    expect(skill.name).toBe('confluence');
    expect(skill.content).toContain('confluence_read');
    expect(skill.invocation.modelInvocable).toBe(true);
    expect(skill.description).toContain('Read-only profile');
  });

  test('advertises writes in the skill only when they are registered', () => {
    const readOnly = plugin.describeSkill({ writes: { enabled: false } });
    const writable = plugin.describeSkill({ writes: { enabled: true } });
    expect(readOnly).toContain('Read-only profile');
    expect(writable).not.toContain('Read-only profile');
    expect(plugin.describeSkill({ writes: { enabled: true } })).toBe(plugin.SKILL_DESCRIPTION);
  });

  test('survives a profile without a skills service', async () => {
    const ctx = fakeCtx({});
    await expect(plugin.apply(ctx, { skill: false })).resolves.toBeUndefined();
    expect(ctx.registered).toHaveLength(READ_TOOL_NAMES.length);
  });
});

describe('settings routes', () => {
  const routes = require('../lib/settings-route.cjs');

  test('normalizes an editable patch', () => {
    const { patch } = routes.validatePatch({
      siteUrl: '  https://company.atlassian.net/wiki ',
      authType: 'bearer',
      confirm: 'never',
      writes: true,
      spaces: [' eng ', 'ENG', 'docs'],
      token: '  token-1  ',
    });

    expect(patch).toEqual({
      siteUrl: 'https://company.atlassian.net/wiki',
      authType: 'bearer',
      confirm: 'never',
      writes: true,
      spaces: ['ENG', 'DOCS'],
      token: 'token-1',
    });
  });

  test('rejects values the tool policy cannot use', () => {
    expect(routes.validatePatch({ spaces: ['ENG*'] }).error).toMatch(/通配符/);
    expect(routes.validatePatch({ spaces: 'ENG' }).error).toMatch(/数组/);
    expect(routes.validatePatch({ spaces: ['bad key!'] }).error).toMatch(/不合法/);
    expect(routes.validatePatch({ authType: 'oauth' }).error).toMatch(/basic 或 bearer/);
    expect(routes.validatePatch({ confirm: 'sometimes' }).error).toMatch(/ask 或 never/);
    expect(routes.validatePatch({ preflightTtlMs: 1000 }).error).toMatch(/不能小于/);
    expect(routes.validatePatch({ token: 5 }).error).toMatch(/字符串/);
    expect(routes.validatePatch({ nope: 1 }).error).toMatch(/未知字段/);
    expect(routes.validatePatch(null).error).toMatch(/对象/);
  });

  test('merges a patch over the existing row and drops blanked fields', () => {
    const next = routes.nextConfig(
      { confirm: 'ask', domain: 'old.example.com' },
      { siteUrl: '', writes: true, spaces: ['ENG'], confirm: 'never' },
    );

    expect(next).toEqual({ domain: 'old.example.com', writes: true, spaces: ['ENG'], confirm: 'never' });
  });

  test('guards every route on the page header and a loopback host', () => {
    expect(routes.requestAllowed({ headers: {} })).toBe(false);
    expect(routes.requestAllowed({ headers: { 'x-dsh-confluence': '1', host: 'example.com' } })).toBe(false);
    expect(routes.requestAllowed({
      headers: { 'x-dsh-confluence': '1', host: '127.0.0.1:55095', origin: 'http://evil.test' },
    })).toBe(false);
    expect(routes.requestAllowed({
      headers: { 'x-dsh-confluence': '1', host: '127.0.0.1:55095', origin: 'http://127.0.0.1:55095' },
    })).toBe(true);
    expect(routes.requestAllowed({ headers: { 'x-dsh-confluence': '1', host: 'localhost:60886' } })).toBe(true);
  });

  test('finds the plugin row among the addressable entries', () => {
    const row = { entry: { options: { id: 'confluence', config: { writes: false } } }, inherited: {}, override: {} };
    const other = { entry: { options: { id: 'ui-theme' } }, inherited: {}, override: {} };
    expect(routes.findRow([other, row])).toBe(row);
    expect(routes.findRow([other])).toBeUndefined();
    expect(routes.findRow(undefined)).toBeUndefined();
  });

  test('never echoes the token or the child environment', () => {
    const visible = routes.visibleConfig({
      siteUrl: 'https://x', token: 'secret', env: { CONFLUENCE_API_TOKEN: 'secret' }, writes: true,
    });
    expect(visible).toEqual({ siteUrl: 'https://x', writes: true });
    expect(routes.tokenSource({ token: 'secret' }, {})).toBe('settings');
    expect(routes.tokenSource({}, { CONFLUENCE_API_TOKEN: 'secret' })).toBe('environment');
    expect(routes.tokenSource({}, {})).toBe('external');
  });

  test('reports stored configuration and token state', () => {
    const editor = {
      configuration: () => [{
        entry: { options: { id: 'confluence', config: { siteUrl: 'https://x', token: 'secret', writes: true } } },
        inherited: {},
        override: { writes: true },
      }],
    };
    const state = routes.readState({ editor, env: {}, liveStatus: () => ({ tools: 29 }), logger: { warn: () => {} } });

    expect(state.supported).toBe(true);
    expect(state.stored).toEqual({ siteUrl: 'https://x', writes: true });
    expect(state.hasToken).toBe(true);
    expect(state.tokenSource).toBe('settings');
    expect(state.live).toEqual({ tools: 29 });

    expect(routes.readState({
      editor: undefined, env: {}, liveStatus: () => ({}), logger: { warn: () => {} },
    }).supported).toBe(false);
  });
});

describe('client half', () => {
  const source = fs.readFileSync(path.join(DSH_ROOT, 'client', 'client.js'), 'utf8');

  function loadClientModule(language = 'zh-CN') {
    const loaded = [];
    const windowStub = { __ModuleLoader__: { load: entry => loaded.push(entry) } };
    const reactStub = {
      createElement: (...args) => ({ type: 'element', args }),
      useCallback: fn => fn,
      useEffect: () => {},
      useRef: value => ({ current: value }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    };
    // The bundle is a plain browser script: run it against stubbed globals.
    const run = new Function('window', 'document', 'navigator', 'fetch', 'require', source);
    run(
      windowStub,
      { documentElement: { lang: language }, readyState: 'complete', addEventListener: () => {} },
      { languages: [language] },
      async () => ({ ok: true, status: 200, text: async () => '{}' }),
      name => (name === 'react' ? reactStub : undefined),
    );
    expect(loaded).toHaveLength(1);
    return { entry: loaded[0], plugin: loaded[0].factory(name => (name === 'react' ? reactStub : undefined)) };
  }

  test('declares the module-loader contract with the package identity', () => {
    const { entry, plugin } = loadClientModule();
    const manifest = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'package.json'), 'utf8'));

    expect(entry.id).toBe(manifest.name);
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.inject).toEqual(['slots']);
    expect(typeof plugin.apply).toBe('function');
  });

  test('registers the settings page and its nav icon', () => {
    const { plugin } = loadClientModule();
    const registered = [];

    const ctx = {
      effect: callback => callback(),
      slots: {
        inject: (_key, callback) => callback(),
        register: (options, component) => {
          registered.push({
            id: options.id,
            label: typeof options.label === 'function' ? options.label() : options.label,
            order: options.order,
            slot: options.name,
            component,
          });
          return () => {};
        },
      },
    };

    plugin.apply(ctx);

    expect(registered.map(row => row.slot)).toEqual(['settings.section', 'settings.section.icon']);
    for (const row of registered) {
      expect(row.id).toBe('confluence');
      expect(typeof row.component).toBe('function');
    }
    expect(registered[0].label).toBe('Confluence');
    expect(registered[0].order).toBe(26);
  });
});

describe('offline dependencies', () => {
  const { createHash } = require('node:crypto');
  const { spawnSync } = require('node:child_process');

  const depsDir = path.join(DSH_ROOT, 'deps');
  const archive = path.join(depsDir, 'node_modules.tar.gz');
  const checksumFile = path.join(depsDir, 'node_modules.sha256');

  const probes = [
    'node_modules/confluence-cli/package.json',
    'node_modules/confluence-cli/lib/pi/operation-policy.js',
    'node_modules/@deepseek-ai/schemastery/package.json',
  ];

  test('ships a dependency archive with a matching checksum', () => {
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(checksumFile)).toBe(true);

    const expected = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    expect(actual).toBe(expected);
    expect(fs.statSync(archive).size).toBeLessThan(45 * 1024 * 1024);
  });

  test('archives the runtime packages the plugin resolves at activation', () => {
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    if (listing.error !== undefined) {
      // No tar on PATH: the checksum above still guards the bytes.
      expect(listing.error.code).toBeTruthy();
      return;
    }
    expect(listing.status).toBe(0);

    const entries = new Set(listing.stdout.split(/\r?\n/).map(line => line.trim()));
    for (const probe of probes) {
      expect(entries.has(probe)).toBe(true);
    }
  });

  test('ships both dependency scripts', () => {
    for (const script of ['pack-deps.mjs', 'install-offline.mjs']) {
      const file = path.join(DSH_ROOT, 'scripts', script);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('node_modules');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'package.json'), 'utf8'));
    expect(manifest.scripts['deps:install']).toBe('node scripts/install-offline.mjs');
    expect(manifest.scripts['deps:pack']).toBe('node scripts/pack-deps.mjs');
  });
});

describe('bundle assets', () => {  test('ships a skill body', () => {
  const content = fs.readFileSync(path.join(DSH_ROOT, 'SKILL.md'), 'utf8');
  expect(content.startsWith('# ')).toBe(true);
  expect(content).toContain('confluence_update');
  expect(content).not.toMatch(/^---/m);
});

test('ships locale metadata that points at an existing detail document', () => {
  for (const locale of ['en', 'zh']) {
    const metadata = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'locale', `${locale}.json`), 'utf8'));
    expect(metadata.meta.title).toBe('Confluence');
    expect(metadata.meta.description.length).toBeGreaterThan(20);
    expect(fs.existsSync(path.join(DSH_ROOT, metadata.meta.detail))).toBe(true);
  }
});

test('ships a self-contained icon', () => {
  const icon = fs.readFileSync(path.join(DSH_ROOT, 'icon.svg'), 'utf8');
  expect(icon).toContain('<svg');
  expect(icon).toContain('viewBox="0 0 36 36"');
  expect(icon).not.toMatch(/<text|<style|<image|foreignObject|onload=/);
  expect(fs.statSync(path.join(DSH_ROOT, 'icon.svg')).size).toBeLessThan(256 * 1024);
});

test('declares the bundle patch and exports', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'package.json'), 'utf8'));
  expect(manifest.type).toBe('module');
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
  expect(manifest.exports['./icon']).toBe('./icon.svg');
  expect(fs.existsSync(path.join(DSH_ROOT, manifest.dsh.bundle.patch))).toBe(true);
  const patch = fs.readFileSync(path.join(DSH_ROOT, manifest.dsh.bundle.patch), 'utf8');
  expect(patch).toContain('name: dsh-plugin-confluence');
});
});
