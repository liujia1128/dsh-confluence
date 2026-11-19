# Confluence tools for DeepSeek Harness

Registers typed `confluence_*` tools and a `confluence` skill inside DeepSeek Harness. Every call is executed by a `confluence-cli` engine in a child process, so the CLI remains the single implementation of authentication, rate limiting, Markdown↔storage conversion, and JSON output.

## What you get

**Read tools** (always available): `confluence_read`, `confluence_search`, `confluence_info`, `confluence_find`, `confluence_spaces`, `confluence_children`, `confluence_export`, `confluence_convert`, `confluence_versions`, `confluence_comments`, `confluence_attachments`, `confluence_property_list`, `confluence_property_get`.

**Write tools** (only when writes are enabled with an allowed-space list): `confluence_create`, `confluence_create_child`, `confluence_update`, `confluence_move`, `confluence_delete`, `confluence_comment_create`, `confluence_comment_delete`, `confluence_property_set`, `confluence_property_delete`, `confluence_attachment_upload`, `confluence_attachment_delete`, `confluence_version_delete`, `confluence_copy_tree_preview` / `confluence_copy_tree`, `confluence_versions_purge_preview` / `confluence_versions_purge`.

**Skill**: `confluence` — model-invoked guidance for formats, write discipline, bulk approval, local-file bounds, and error codes.

## Credentials

The tools inherit the CLI's normal configuration. Nothing is stored by the plugin:

```sh
export CONFLUENCE_DOMAIN=company.atlassian.net
export CONFLUENCE_API_PATH=/wiki/rest/api
export CONFLUENCE_AUTH_TYPE=basic
export CONFLUENCE_EMAIL=you@company.com
export CONFLUENCE_API_TOKEN=...        # or `confluence init`, Keychain, ~/.netrc
```

## Enabling writes

Writes are off unless a space allowlist is configured. Override the bundle row in the profile's own patch layer (a matching override replaces the whole `config`):

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
| `writes` | `false` (or `CONFLUENCE_PI_WRITES`) | Register the write tools. |
| `spaces` | `CONFLUENCE_PI_WRITE_SPACES` | Allowed space keys; wildcards are rejected. |
| `confirm` | `ask` | `ask` routes every write through `ctx.approval`; `never` skips the prompt. |
| `confluence.*` | — | `domain`, `siteUrl`, `apiPath`, `authType`, `email`, `username`, `profile`, `protocol`, `linkStyle`, `plantumlFormat`, `forceCloud`. |
| `env` | — | Extra child-process environment (the runner still forwards only `CONFLUENCE_*`, `NETRC`, `HOME`, `PATH`, `NO_COLOR`). |
| `packageRoot` | auto | confluence-cli package directory that owns `bin/index.js`; overrides `CONFLUENCE_CLI_ROOT`, a surrounding checkout, and the installed dependency. |
| `nodePath` | `DSH_NODE_EXECUTABLE` | JavaScript runtime used for the CLI child process. |
| `workingDirectory` | session directory | Fallback directory that bounds local file access. |
| `preflightTtlMs` | `300000` | Lifetime of a bulk approval id. |
| `skill` | `true` | Register the `confluence` skill. |

`CONFLUENCE_READ_ONLY=true` always wins: the write tools are not registered.

The write surface is decided at activation, so reload the plugin (or restart the Harness) after changing `writes` or `spaces`; otherwise the session keeps the tool list it registered. A read-only session can still be told the write tools do not exist — do not re-check by trying one.

## Safety model

1. Write tools are registered only with an explicit enable **and** a non-empty allowlist.
2. Each ordinary write runs local preflight (which resolves the real title, id, and space), checks the space allowlist, then asks `ctx.approval` for one-use permission. The preflight summary is the audited approval reason.
3. Bulk operations are two-step: a preview issues a single-use id plus the affected-page summary; execution re-runs preflight, rejects a changed plan with `STALE_PREFLIGHT`, and asks for approval again.
4. Local files (export destinations, converted inputs/outputs, attachment uploads and downloads) must stay inside the session working directory, and uploaded or converted inputs are re-hashed after approval (`STALE_FILE`).
5. Every result is prefixed as untrusted external content.

## Settings page

The bundle contributes one page to **Settings**, between Fonts and Market: `Confluence` (`settings.section` id `confluence`, order 26, with its own navigation icon). It edits this plugin's own row, so the terminal, the profile patch and the page never disagree.

| Area | Fields |
|---|---|
| Site and authentication | Site URL, host name (optional), API base path, authentication (`basic`/`bearer`), email, CLI profile, API token |
| Write access | Register write tools, allowed space keys, approval mode |
| Current runtime | Registered tool count, allowed spaces, approval mode, CLI root |

- **Storage.** Saving writes the `confluence` row of *this profile's* `cordis.patch.yml` through `configEditor` — the same row the bundle inserts — and the loader reconciles it immediately, so the tool set changes without a restart. Blanked text fields are removed from the row rather than stored as empty strings.
- **Derivation.** A site URL is enough: the plugin derives the CLI's `CONFLUENCE_DOMAIN` from its host, and `CONFLUENCE_API_PATH` from its path (`/wiki` → `/wiki/rest/api`, `/ex/confluence/<id>/wiki` → the same plus `/rest/api`). An explicit host name or API path always wins; a URL without a path leaves the base path to the CLI's own inference from the host.
- **Token.** The token is stored in that row like any other field; the page only ever shows whether one is set. Prefer `CONFLUENCE_API_TOKEN` in the environment if the token must not live in the patch file.
- **Precedence.** Page values win over `CONFLUENCE_*` environment variables for the same field; a field left empty falls back to the environment, `confluence init`'s profile, the Keychain, or `~/.netrc`.
- **Test connection.** Runs one `spaces --limit 1` read with the values in force and reports the space count or the CLI's own error, so a wrong domain or token is visible before the first real call.
- **Transport.** The page talks to the Host over three same-origin routes under `/dsh-confluence` (`state`, `save`, `test`). Every route first asks the composition's `connection` service for a rejection (`requestRejection`: the Host/Origin fence plus browser authentication the shipped routes run behind), then requires the page's own `x-dsh-confluence` header and a loopback `Host`, and refuses a mismatched `Origin`, so a cross-site page cannot drive it.

## Requirements and limits

- The bundle needs a `confluence-cli` package to execute: its declared dependency, a surrounding checkout, `CONFLUENCE_CLI_ROOT`, or `packageRoot`. A missing one fails at activation with instructions. Run `npm install` in a cloned bundle so its dependencies exist.
- On a machine without network access, run `node scripts/install-offline.mjs` instead: it verifies `deps/node_modules.tar.gz` and extracts it. Add the folder as a **local directory** plugin afterwards — the git address would run a package install.
- A write that times out or is interrupted fails as `UNKNOWN_RESULT`: the plugin never retries it.
- Deleting page versions requires the instance to allow it; that failure surfaces as `CLI_FAILED`.
