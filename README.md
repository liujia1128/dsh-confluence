# dsh-plugin-confluence

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that puts Atlassian Confluence into every DSH session: 29 typed `confluence_*` tools, a `confluence` skill, and a Settings page for the connection and the write policy.

中文说明见 [readme_zh.txt](readme_zh.txt)。

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

## Configure

Open **Settings → Confluence** — the page this bundle contributes:

| Area | Fields |
|---|---|
| Site and authentication | Site URL, host name (optional), API base path, authentication (`basic`/`bearer`), email, CLI profile, API token |
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
| `siteUrl` / `domain` | — | The site, as a full URL or a bare host name. |
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
| `nodePath` | DSH runtime | JavaScript runtime used for the CLI child process. |
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
6. The Settings API is three same-origin routes under `/dsh-confluence`; each requires the page's own `x-dsh-confluence` header and a loopback `Host`, and refuses a mismatched `Origin`.

## Development

```bash
npm install
npm test
```

The suite covers configuration resolution, the tool surface, argument validation, read/write/bulk execution, approval wiring, the settings routes, and the client module contract (61 tests).

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

## License

MIT
