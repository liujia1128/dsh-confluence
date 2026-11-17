# deps/

Runtime dependencies for offline installs.

| File | Why it is here |
|---|---|
| `node_modules.tar.gz` | The production dependency tree (`npm ci --omit=dev --ignore-scripts` from `package-lock.json`), archived so a machine without network access can install it. 107 packages, no native binaries — it works on any platform. |
| `node_modules.sha256` | Checksum of the archive. `scripts/install-offline.mjs` refuses a mismatch, and `tests/plugin.test.js` fails if the two disagree. |

Install:

```bash
node scripts/install-offline.mjs     # add --force to replace an existing node_modules
```

Then add this directory to DSH as a **local directory** plugin. Do not add the git URL on an offline machine: that path runs a package install and needs the network.

Rebuild after changing a dependency:

```bash
npm run deps:pack
```

Commit both files together — the checksum is what makes the archive trustworthy.
