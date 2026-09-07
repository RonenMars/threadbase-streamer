# Windows setup

Entry point for getting a Windows machine from a fresh clone (or a copied/synced checkout) to a working local build and deploy. The individual symptoms below each have a full write-up in [docs/troubleshooting.md](../troubleshooting.md); this guide is the "what to do in order" version so the first Windows setup doesn't have to rediscover them one crash at a time.

See also: [docs/guides/deploy-internals.md#windows-local-deploys](deploy-internals.md#windows-local-deploys) for what `deploy.ps1` actually does, and [docs/guides/prod-dev-lifecycle.md](prod-dev-lifecycle.md) for the Task Scheduler prod/dev model.

## 1. Node version

Install the Node version pinned in `.nvmrc`. Running a different major is the single biggest source of "works on my machine" native-module failures on Windows (see `docs/troubleshooting.md` → "Native modules / ABI mismatches").

- **fnm** (recommended): install [fnm](https://github.com/Schniz/fnm), then add `fnm env --use-on-cd | Out-String | Invoke-Expression` to your PowerShell profile (`$PROFILE`) so it auto-switches on `cd`.
- **nvm-windows**: reads `.nvmrc` but has no auto-cd hook — run `nvm use` manually after every `cd` into the repo.

`scripts/deploy.ps1` runs `scripts/check-node-version.mjs` as its first step and refuses to continue on the wrong major, specifically because nvm-windows has no auto-cd hook and it's easy to deploy from a shell still on an old Node version.

## 2. `npm install` — the native-module fork in the road

Which way `npm install` goes on Windows depends on your **npm major**, not on whether Visual Studio is installed. **You do not need to install Visual Studio.** Nothing in this repo actually needs a compiler — `better-sqlite3` and `node-pty` both ship prebuilt binaries.

The thing that goes wrong is one implicit step: `better-sqlite3` v13 ships no `install` script, so npm synthesizes a `node-gyp rebuild` from its `binding.gyp` and compiles from source even though a working prebuilt binary is already in the tarball. Whether that step runs is the whole story.

- **npm 12+ — the recommended path.** A plain `npm install` works with no toolchain. `package.json` carries `"allowScripts": { "node-pty": true }`, which blocks every *other* dependency install script — the synthesized gyp included — and npm 12 is the first major that honours the field. The `.nvmrc` Node bundles npm 11, so upgrade npm once:

  ```powershell
  npm install -g npm@12
  npm install
  ```

  The install ends with `npm warn install-scripts 4 packages had install scripts blocked because they are not covered by allowScripts`, naming `better-sqlite3`, both `esbuild` copies and `protobufjs`. That warning is the mechanism working — leave all four blocked. Note npm 12 blocks dependency install scripts in *every* project on the machine, not just this one; see [the troubleshooting entry](../troubleshooting.md#local-install-npm-12) for the full trade and how to revert.

- **npm 10/11 with a C++ toolchain** (VS2019/2022, "Desktop development with C++" workload): a plain `npm install` works, but only by spending the time compiling a binary that was already on disk.

- **npm 10/11 without a toolchain** (the common case — most dev machines don't have a full VS install, and VS2017 Build Tools alone is *not* enough for Node 24's node-gyp): a plain `npm install` fails with `gyp ERR! find VS ... Could not find any Visual Studio installation to use`. Upgrade npm per the first bullet. If you can't, skip the implicit script instead:

  ```powershell
  npm install --ignore-scripts
  ```

  `--ignore-scripts` also skips this **root package's own** lifecycle scripts, two of which are load-bearing and must be run by hand afterward:

  ```powershell
  npx patch-package        # was `prepare` — without it qrcode-terminal keeps a legacy octal
                            # escape that fails the tsup build
  # postinstall (node-pty spawn-helper permissions) has no Windows equivalent to run by
  # hand; it's a no-op on this platform, unlike macOS/Linux.
  ```

  This is the same trick `.github/workflows/ci.yml`'s Windows smoke job uses — CI keeps it rather than moving to npm 12 because the runners' npm major is not pinned and the flag works on every one of them. It's fully documented in `docs/troubleshooting.md` under "`npm ci` fails on Windows with `gyp ERR! find VS` for `better-sqlite3`" and "`npm install --ignore-scripts` recovery still fails the build (`qrcode-terminal` legacy octal escape)" — read those two entries together if either step above still fails.

**A gotcha that used to live here is gone.** `@threadbase-sh/scanner` once vendored its *own* nested `better-sqlite3` copy that no toolchain-less install could build, and installing the VS toolchain was the only fix. Scanner 0.14.6 aligned its range with the root's, so npm dedupes to a single top-level copy and there is no nested binding to build. Confirm on any checkout with `npm ls better-sqlite3` — one `deduped` line under the scanner and one top-level entry means you're clear. The [nested-scanner entry](../troubleshooting.md) in troubleshooting.md is kept only for branches that predate the bump.

## 3. Verify `node_modules` isn't stale before deploying

`git pull` / `git worktree add` / switching branches does **not** refresh `node_modules`. If a pulled `package.json`/`package-lock.json` changed, the existing `node_modules` silently keeps the old versions until you reinstall:

```powershell
npm ls --depth=0   # an "invalid: <range> from the root project" line means node_modules is stale
```

If everything shows `UNMET DEPENDENCY`, `node_modules` wasn't installed for *this* checkout at all — common right after a fresh `git worktree add`, since a worktree does not inherit the main checkout's `node_modules`. Reinstall per step 2 above.

## 4. A checked-out worktree's `.git` file must point at a *live* path on *this* machine {#broken-git-worktree-link}

`git worktree add <path> <branch>` writes an absolute path into `<path>/.git` (`gitdir: /abs/path/to/main-repo/.git/worktrees/<name>`). If that directory is later copied, zipped, or synced to another machine — or even to a different path on the same machine — the `.git` file still points at the old location, and **every** `git` command inside the copy fails:

```
fatal: not a git repository: (NULL)
```

This is easy to miss because the harness/editor may still report "is a git repository: true" (it sees the `.git` file and assumes it resolves), and the failure only surfaces once something actually shells out to `git` — for this repo, that's `scripts/deploy.ps1`, which crashes with a confusing `You cannot call a method on a null-valued expression` a few lines after the real `git` error. See [the troubleshooting entry](../troubleshooting.md#deployps1-crashes-with-fatal-not-a-git-repository-null--you-cannot-call-a-method-on-a-null-valued-expression-windows) for the exact fix (re-point or re-clone) and the workaround `deploy.ps1` now has for deploying anyway with `-Force`.

**Takeaway:** don't sync a `git worktree` checkout across machines or paths by copying files. Push the branch and `git worktree add` fresh on the target machine instead.

## 5. Deploying

```powershell
npm run deploy:windows          # linted + tested deploy, requires a clean main checkout
npm run deploy:windows:force    # skips lint/tests/dirty-tree/git checks — use for a
                                 # non-main integration checkout or a broken git link
```

`-Force` is what makes deploying possible from the broken-worktree-link state in step 4 above, and it's also what you want on any checkout that isn't `main` (an integration branch, a feature worktree). It does **not** fix the underlying `node_modules`/git issues — those still need steps 2–4 above resolved first, `-Force` only relaxes the branch/dirty-tree/git-availability *gates*, not the build itself.

If a deploy reports a healthcheck failure but `Invoke-RestMethod http://localhost:8766/healthz` succeeds manually right after, that's very likely the known 15-second-probe race — see [troubleshooting.md](../troubleshooting.md#deployps1-reports-healthcheck-failed-but-the-server-actually-started-fine-windows).

If a deploy succeeds but the server then crashes on every subsequent start with a `better-sqlite3`/ABI-looking error, see [the stale-binary entry](../troubleshooting.md#windows-deploy-completes-but-the-server-crashes-on-every-start-with-a-stale-better-sqlite3-binary-silent-even-though-npm-installdeployps1-reported-success) — this was a real bug in the deploy script's copy step, fixed, but worth knowing the symptom if you're on a checkout that predates the fix.

## 6. Everything else

Task Scheduler quirks (log redirection, env vars not picked up live, stale port 8766), Cloudflare Tunnel on Windows, and submodule SSH→HTTPS are all covered in the `CLAUDE.md`/`AGENTS.md` "Windows-specific notes" section and in `docs/troubleshooting.md`'s "Windows-specific issues" section — this guide only covers the setup path that gets you to a first successful `npm install` + deploy.
