# dsh-plugin-confluence

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that puts Atlassian Confluence into every DSH session: 29 typed `confluence_*` tools, a `confluence` skill, and a Settings page for the connection and the write policy.

中文说明见 [README_ZH.md](README_ZH.md)（[纯文本版](readme_zh.txt)）。

Every call is executed by [confluence-cli](https://github.com/pchuri/confluence-cli) in a child process, so authentication, rate limiting, Markdown↔storage conversion, and JSON envelopes behave exactly as they do in a terminal — and the CLI stays the single implementation of the Confluence API surface.

## Tools

| Area | Tools |
|---|---|
| Read (13) | `confluence_read`, `confluence_search`, `confluence_info`, `confluence_find`, `confluence_spaces`, `confluence_children`, `confluence_export`, `confluence_convert`, `confluence_versions`, `confluence_comments`, `confluence_attachments`, `confluence_property_list`, `confluence_property_get` |
| Write (16) | `confluence_create`, `confluence_create_child`, `confluence_update`, `confluence_move`, `confluence_delete`, `confluence_comment_create`, `confluence_comment_delete`, `confluence_property_set`, `confluence_property_delete`, `confluence_attachment_upload`, `confluence_attachment_delete`, `confluence_version_delete`, `confluence_copy_tree_preview` / `confluence_copy_tree`, `confluence_versions_purge_preview` / `confluence_versions_purge` |

Read tools always register. Write tools register only when the plugin row enables them with an allowed-space list; a write runs local preflight, checks that allowlist, asks the harness approval channel, then mutates. Bulk operations are two-step: a preview resolves every affected page and returns a single-use approval id, and the execute tool accepts nothing else.

Every result is prefixed as untrusted external content.

## Requirements

- DeepSeek Harness with a profile (tested on 0.2.2).
- Node.js 20 or newer.
- Confluence credentials: `CONFLUENCE_*` environment variables, `confluence init`, the macOS Keychain, or `~/.netrc`. The plugin stores nothing by itself.

## Install

**From this repository** — in DSH, add the plugin by spec:

```
Plugins → Add plugin → https://github.com/liujia1128/dsh-confluence
```

or from an agent session, `plugin_manager` with `action: install_bundle` and that address as `target`.

**From a clone** (development, or a pinned revision):

```bash
git clone https://github.com/liujia1128/dsh-confluence
cd dsh-confluence
npm install          # the bundle needs its own dependencies when linked
```

then add the checkout directory as the plugin. A local directory install links the folder, so edits apply after a plugin reload.

**Offline / air-gapped machine** — the runtime dependencies are committed to this repository, so no package install is needed:

```bash
# on the offline machine, from the repository folder
node scripts/install-offline.mjs     # verifies deps/node_modules.tar.gz, extracts it
```

Then add **this directory** as the plugin (local directory install). Do not add the git address on an offline machine: that path runs a package install and needs the network. `npm run deps:pack` rebuilds the archive from `package-lock.json` after a dependency change; details in [deps/README.md](deps/README.md).

## Configure

Open **Settings → Confluence** — the page this bundle contributes. Three values are enough to start: **site URL**, the **email** you sign in with (Cloud), and an **API token**. For Server 6.x without PAT, use **username** + **password** with `basic` auth instead. The host name and REST base path are derived from the site URL; fill them only to override the derivation.

| Area | Fields |
|---|---|
| Site and authentication | Site URL, host name (optional), API base path, authentication (`basic`/`bearer`), email, username, CLI profile, API token |
| Write access | Register write tools, allowed space keys, approval mode |
| Current runtime | Registered tool count, allowed spaces, approval mode, CLI root |

Saving writes the `confluence` row of *this profile's* `cordis.patch.yml` through `configEditor` and the loader reconciles it immediately, so the tool set changes without a restart. **Test connection** runs one `spaces --limit 1` read and reports the space count or the CLI's own error. The token is stored in that row and is only ever echoed back as "set"; use `CONFLUENCE_API_TOKEN` in the environment if it must not live in the file.

The same row can be written by hand:

```yaml
- id: confluence
  name: dsh-plugin-confluence
  config:
    writes: true
    spaces: [ENG, DOCS]
    confirm: ask
    confluence:
      domain: company.atlassian.net
      apiPath: /wiki/rest/api
      authType: basic
      email: you@company.com
    env:
      CONFLUENCE_API_TOKEN: !!js process.env.CONFLUENCE_API_TOKEN
```

| Key | Default | Meaning |
|---|---|---|
| `siteUrl` / `domain` | — | The site, as a full URL or a bare host name. A site URL alone is enough: the host name and REST base path are derived from it. |
| `apiPath` | — | `/wiki/rest/api` on Cloud, `/rest/api` on Server/Data Center. |
| `authType` | `basic` | `basic` (email + API token) or `bearer` (Data Center personal access token). |
| `email` / `username` | — | Identity for `basic`. |
| `token` | — | API token; falls back to the environment, the Keychain, or `~/.netrc`. |
| `profile` | — | A `confluence-cli` named profile. |
| `writes` | `false` | Register the write tools. |
| `spaces` | — | Allowed space keys; wildcards are rejected. Empty disables writes. |
| `confirm` | `ask` | `ask` routes every write through the harness approval channel; `never` skips it. |
| `preflightTtlMs` | `300000` | Lifetime of a bulk approval id. |
| `packageRoot` | auto | confluence-cli package directory, when you want a specific copy. |
| `nodePath` | auto-discovered | JavaScript runtime used for the CLI child process. Discovery order: the plugin-shipped `runtime/node(.exe)`, the Node bundled with the DSH installation (`resources/runtime/primary-runtime/…/node/bin`), then the DSH Electron binary with `ELECTRON_RUN_AS_NODE=1`. Some packaged Electron builds refuse Node mode (test connection reports `INVALID_JSON` with Chromium cache errors on stderr); point `nodePath` at a real node.exe |
| `skill` | `true` | Register the `confluence` skill. |

`CONFLUENCE_READ_ONLY=true` always wins: the write tools are not registered.

## Which confluence-cli runs?

First hit wins:

1. `packageRoot` on the plugin row;
2. `CONFLUENCE_CLI_ROOT` in the environment;
3. a checkout that surrounds this bundle (`..` twice) — how the upstream repository develops it;
4. the `confluence-cli` dependency this package installs.

A wrong or missing candidate fails loudly at activation with instructions, rather than silently picking another copy.

## Safety model

1. Write tools exist only with an explicit enable **and** a non-empty space allowlist.
2. Each ordinary write runs local preflight (which resolves the real title, id, and space), checks the allowlist, then requests one-use approval from the harness. The preflight summary is the audited approval reason.
3. Bulk writes are preview → execute: the execution re-runs preflight, rejects a changed plan with `STALE_PREFLIGHT`, and asks for approval again.
4. Files touched by a write (body, property, attachment uploads) are hashed before approval and re-hashed after it (`STALE_FILE`); local paths must stay inside the session working directory.
5. A write that times out or is interrupted fails as `UNKNOWN_RESULT` and is never retried automatically.
6. The Settings API is three same-origin routes under `/dsh-confluence`; each asks the composition's `connection` service for a rejection first (`requestRejection`: the Host/Origin fence plus browser authentication every shipped route runs behind), then requires the page's own `x-dsh-confluence` header and a loopback `Host`, and refuses a mismatched `Origin`.

## Development

```bash
npm install
npm test
```

The suite covers configuration resolution, the tool surface, argument validation, read/write/bulk execution, approval wiring, the settings routes, the client module contract, and the offline dependency archive (66 tests). CI runs `npm ci` + `npm test` on Node 20 / 22 / 24.

After changing a dependency, rebuild the offline archive on a machine with network access:

```bash
npm run deps:pack     # rewrites deps/node_modules.tar.gz and deps/node_modules.sha256
```

Commit both files together — the checksum is what makes the archive trustworthy, and the tests fail when they disagree.

| Path | Role |
|---|---|
| `index.js` | ESM entry: `apply`, `inject`, plugin name, `Config` schema. |
| `lib/plugin.cjs` | Wires config, engine, tools, approval, skill, and the settings routes. |
| `lib/engine.cjs` | Resolves confluence-cli and loads its `lib/pi/*` engine. |
| `lib/config.cjs` | Row config + environment → CLI environment and write policy. |
| `lib/tools.cjs` | Tool specs, schemas, and per-call execution. |
| `lib/args.cjs` | Argument validation for the declared schema subset. |
| `lib/settings-route.cjs` | The three settings routes: state, save, test. |
| `client/client.js` | The Settings page and its navigation icon (browser module). |
| `SKILL.md` | The `confluence` skill contributed at activation. |
| `docs/DETAIL.md` | Longer configuration and behaviour notes shown in Plugin Manager. |
| `locale/`, `icon.svg` | Plugin Manager display metadata. |
| `deps/` | Committed runtime dependency archive and its checksum, for offline installs. |
| `scripts/` | `deps:pack` rebuilds the archive; `deps:install` extracts it offline. |

## License

MIT
