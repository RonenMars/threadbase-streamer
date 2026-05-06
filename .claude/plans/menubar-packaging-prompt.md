# Prompt: Package `threadbase-menubar` with electron-builder for Windows & macOS

You are an implementation engineer. I am the architect. This brief is your spec — follow it precisely. Where I leave a decision open, exercise judgment and document the call you made.

---

## 1. Context

`threadbase-menubar` is an Electron tray app (submodule at `vendor/menubar/` inside `threadbase-streamer`). It currently runs **from source** via `electron .` against the dev tree. Two consequences:

1. The dev directory is held open by 4+ Electron child processes, blocking refactors as trivial as renaming the parent folder.
2. There is no user-facing install story — no Start-menu entry, no `.app` bundle, no uninstaller, no code signature, no autoupdate channel.

We are moving to a packaged distribution using **electron-builder**. The streamer itself stays as-is; the menubar becomes a proper desktop application installed independently of the source tree.

**Target platforms (this task):** Windows 10/11 (x64) and macOS 12+ (universal arm64+x64). Linux is out of scope for this iteration but the configuration must not preclude adding it later.

## 2. Current state — what is already true

Read these files before you start:

- `vendor/menubar/package.json` — current scripts: `build` (tsc), `start` (build && electron .). No packager wired up.
- `vendor/menubar/src/main.ts` — Electron main. **Loads renderer via `../src/renderer/index.html` relative to `dist/`.** This path is invalid inside an asar archive. The submodule's own `CLAUDE.md` explicitly flags it: *"Do not 'fix' this path until packaging with electron-builder is implemented."* You are now that implementation — fix it.
- `vendor/menubar/src/renderer/` — vanilla HTML/CSS/JS. **Not** processed by `tsc`. Must be copied into the package as-is.
- `vendor/menubar/src/icons.ts` — generates 16×16 PNG tray icons at runtime in pure JS. The packaged build still needs **app icons** (`.ico`, `.icns`) for window chrome / installer / dock — those are separate from the runtime-generated tray icons.
- `vendor/menubar/CLAUDE.md` — read in full. Note especially the Windows tray-overflow positioning behavior, the login-item logic, and the `electron.cmd` warning (parent-cmd-exits problem).
- Parent `threadbase-streamer/CLAUDE.md` — note Windows-specific deploy idioms: Task Scheduler, port 8766, deploy scripts under `scripts/deploy.ps1`.

## 3. Goals (acceptance criteria)

A run of `npm run package:win` on a Windows host and `npm run package:mac` on a Mac host must each produce a distributable artifact that:

1. **Installs cleanly** to a per-user location with no admin/sudo prompt:
   - Windows: `%LOCALAPPDATA%\Programs\Threadbase Menubar\` via NSIS one-click installer.
   - macOS: `/Applications/Threadbase Menubar.app` via DMG (or zip — pick one and justify).
2. **Runs from the installed location**, not the source tree. After install, deleting or renaming `vendor/menubar/` must not affect the running app.
3. **Tray icon appears** within 3 seconds of launch on both OSes; `/healthz` polling against `http://localhost:3456` continues to work; status icon transitions green/gray as before.
4. **Renderer popup opens** when the tray icon is clicked, with all CSS/JS assets loaded — no `ERR_FILE_NOT_FOUND`, no white screen.
5. **Launch-at-login** toggle still works, persisting across reboots, on both OSes.
6. **Quit** from the tray menu fully exits all Electron child processes (no stragglers in Task Manager / Activity Monitor).
7. The streamer's deploy script exposes a flag that drives this end-to-end (see §6).
8. Source-tree `npm start` (dev workflow) **still works** — packaging must not regress dev ergonomics.

Non-goals for this iteration: code signing, notarization, autoupdate, MAS submission, Linux. Leave hooks for them; do not implement them.

## 4. Implementation plan

### 4.1 Fix the renderer path (prerequisite)

The current `loadFile('../src/renderer/index.html')` is the single biggest blocker. Choose **one** of these and apply it consistently:

**Option α (preferred):** copy renderer assets into `dist/renderer/` at build time and load via `path.join(__dirname, 'renderer', 'index.html')`. Update `tsconfig.json` or add a postbuild step (`cpy`, `shx cp -r`, or a 5-line node script) that copies `src/renderer/**` → `dist/renderer/`. This keeps both dev and packaged runs using the same resolution rule.

**Option β:** keep the renderer at `src/renderer/`, include `src/renderer/**` in the electron-builder `files` glob, and resolve via `path.join(app.getAppPath(), 'src/renderer/index.html')`. Works but conflates "source" and "shipped asset" — uglier.

Pick α unless you find a concrete reason not to. Document the reason if you switch.

Also audit `src/main.ts` for any other paths that assume cwd is the repo root or that walk relative from `dist/`. Same fix applies.

### 4.2 Add electron-builder

In `vendor/menubar/`:

```bash
npm install --save-dev electron-builder
```

Pin to a specific minor (`^25.x` at the time of writing — verify current stable). Pin Electron itself to a single major and document the choice; electron-builder's bundled Electron must match.

### 4.3 `package.json` additions

Add scripts (do not delete existing ones):

```jsonc
"scripts": {
  "build": "tsc && node scripts/copy-renderer.mjs",
  "package": "npm run build && electron-builder",
  "package:win": "npm run build && electron-builder --win",
  "package:mac": "npm run build && electron-builder --mac",
  "package:dir": "npm run build && electron-builder --dir"
}
```

`package:dir` produces an unpacked app folder — invaluable for debugging "works in dev, broken when packaged" issues. Use it heavily during development.

Add the `build` block:

```jsonc
"build": {
  "appId": "com.threadbase.menubar",
  "productName": "Threadbase Menubar",
  "copyright": "Copyright © 2026 Threadbase",
  "directories": {
    "buildResources": "build",
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "package.json",
    "!**/*.map",
    "!**/*.ts"
  ],
  "asar": true,
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "build/icon.ico",
    "artifactName": "${productName}-Setup-${version}.${ext}"
  },
  "nsis": {
    "oneClick": true,
    "perMachine": false,
    "allowToChangeInstallationDirectory": false,
    "createDesktopShortcut": false,
    "createStartMenuShortcut": true,
    "shortcutName": "Threadbase Menubar",
    "runAfterFinish": true,
    "deleteAppDataOnUninstall": false
  },
  "mac": {
    "target": [{ "target": "dmg", "arch": ["universal"] }],
    "icon": "build/icon.icns",
    "category": "public.app-category.developer-tools",
    "hardenedRuntime": false,
    "gatekeeperAssess": false,
    "extendInfo": {
      "LSUIElement": 1
    },
    "artifactName": "${productName}-${version}-${arch}.${ext}"
  },
  "dmg": {
    "title": "Threadbase Menubar ${version}",
    "writeUpdateInfo": false
  }
}
```

Notes on each non-obvious key:

- `directories.buildResources: "build"` — where you put `icon.ico`, `icon.icns`, optional `entitlements.mac.plist`, NSIS hooks. Add `vendor/menubar/build/.gitkeep` and commit the icon assets.
- `asar: true` — bundles JS into a single archive. Faster startup on Windows, smaller install footprint. Verify `icons.ts` runtime PNG generation does not write inside the asar (it shouldn't — it builds buffers in memory).
- `LSUIElement: 1` on macOS — makes the app a **menu-bar-only** app: no Dock icon, no app-switcher entry. This is the correct UX for a tray app and matches the Windows tray behavior. Without it the user sees a useless Dock icon.
- `oneClick: true, perMachine: false` — installs to `%LOCALAPPDATA%`, no UAC prompt. Matches the streamer's per-user deploy model.
- `hardenedRuntime: false, gatekeeperAssess: false` — explicitly opting out of signing/notarization for this iteration. **Document this:** unsigned macOS builds will be quarantined; users must right-click → Open the first time, or run `xattr -dr com.apple.quarantine /Applications/Threadbase\ Menubar.app`. Add this to the README. The next iteration will turn signing on.

### 4.4 Icon assets

Required:

| File | Sizes | Purpose |
|---|---|---|
| `build/icon.ico` | 16, 24, 32, 48, 64, 128, 256 | Windows installer + window chrome |
| `build/icon.icns` | 16, 32, 128, 256, 512, 1024 | macOS app bundle |
| `build/icon.png` | 512×512 | Linux future-proofing |

If the project has no brand icon yet, generate placeholders from a single 1024×1024 PNG using `electron-icon-builder` or `iconutil` (mac). Do **not** commit binary blobs without checking with the maintainer; if no icon exists, ship a placeholder and open a tracking issue.

### 4.5 Login-item behavior in a packaged build

The current code calls `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`. In a packaged build this works correctly on both platforms **provided** the app path is resolvable — which it is once installed. Verify post-install that toggling the setting in the popup writes the correct registry key (Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) or Login Items entry (macOS: `~/Library/Application Support/com.apple.backgroundtaskmanagementagent`).

Do not touch the Linux `.desktop` autostart code path.

### 4.6 Windows-specific gotchas to verify

These are non-negotiable test points — each one has bitten this codebase before:

1. **Tray-icon overflow positioning** — confirm the popup still centers on screen on Windows (not next to the tray) after packaging. The `after-create-window` opacity trick must survive the asar bundle.
2. **Child process cleanup on quit** — Electron spins up ~10 children. Test "Quit from tray" leaves zero `electron.exe` processes. If any survive, fix in `main.ts` (call `app.quit()`, not `mb.app.quit()` if those differ).
3. **No `electron.cmd` anywhere** — the packaged binary is `Threadbase Menubar.exe`. The `.cmd` warning in the menubar's CLAUDE.md is now obsolete for end users, but keep it in dev docs.
4. **Path separators** — any `path.join` in renderer/main code must not assume `/`. The streamer's CLAUDE.md flags this for the parent project; the same rule applies here.

### 4.7 macOS-specific gotchas to verify

1. **`LSUIElement` is set** — confirm no Dock icon appears on launch. This is the single most common menu-bar-app mistake.
2. **Quarantine on first launch** — fresh DMG, drag to /Applications, double-click — Gatekeeper will block. Document the right-click-Open workaround until signing is added.
3. **Universal binary size** — universal builds are roughly 2× the size of single-arch. If size is a concern, ship separate `arm64` and `x64` DMGs instead. Recommend universal for simplicity.
4. **Tray icon rendering on Retina** — the runtime-generated 16×16 PNGs may look soft on Retina displays. If they do, generate `@2x` variants in `icons.ts` and use `nativeImage.createFromBuffer` with `scaleFactor: 2`. Out of scope to fix here unless it ships visibly broken.

## 5. Testing matrix

Before declaring done, run **all** of the following on each OS:

### Windows
1. `npm run package:dir` → launch `release/win-unpacked/Threadbase Menubar.exe` → tray icon appears, popup opens, `/healthz` polling works.
2. `npm run package:win` → run the NSIS installer → app appears in Start menu → launches → tray icon appears.
3. Toggle "Launch at login" → reboot → app starts automatically with no visible window.
4. Right-click tray → Quit → `Get-Process electron` returns nothing.
5. **Critical regression test for the original bug:** with the packaged app running, rename `C:\Users\PC\Desktop\dev\tb-new\threadbase-streamer\vendor\menubar` to `menubar-renamed`. The rename must succeed.
6. Uninstall via Settings → Apps → confirm `%LOCALAPPDATA%\Programs\Threadbase Menubar\` is removed.

### macOS
1. `npm run package:dir` → `open release/mac-universal/Threadbase\ Menubar.app` → tray icon appears in menu bar, no Dock icon.
2. `npm run package:mac` → mount DMG → drag to /Applications → first-launch quarantine prompt → right-click → Open → app starts.
3. Toggle launch-at-login → log out / log in → app reappears in menu bar.
4. Quit from tray → `pgrep -f "Threadbase Menubar"` returns nothing.
5. Move app from `/Applications` to trash → confirm clean removal.

## 6. Wire into the streamer deploy flow

Add to `threadbase-streamer/scripts/deploy.ps1` (and the `.sh` equivalent for macOS dev hosts) a `-IncludeMenubar` switch. When set, after the streamer healthcheck passes:

```powershell
if ($IncludeMenubar) {
  Push-Location "$PSScriptRoot\..\vendor\menubar"
  npm ci
  npm run package:win
  $installer = Get-ChildItem "release\*Setup*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) { throw "electron-builder produced no installer" }
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*\vendor\menubar\*" -or $_.Path -like "*\Threadbase Menubar\*" } |
    Stop-Process -Force
  Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
  Pop-Location
}
```

`/S` = silent install. NSIS one-click + silent = no UI at all. The `runAfterFinish: true` config will auto-launch the freshly-installed app.

For macOS, the equivalent is `hdiutil attach ... && cp -R ... /Applications/ && hdiutil detach`. Encapsulate in a function; do not inline.

Update the `deploy-menubar` skill description to note that it now produces a packaged install, not a source-tree run.

## 7. Documentation updates

- `vendor/menubar/README.md` — add an "Installation" section with download/install steps, the macOS quarantine workaround, and a note that the app uninstalls cleanly.
- `vendor/menubar/CLAUDE.md` — **remove** the line *"Do not 'fix' this path until packaging with electron-builder is implemented"* (now stale). Add a "Packaging" section pointing to `package.json`'s `build` block. Update the Windows "Launching from scripts" section since end users no longer launch via `electron.exe` directly.
- `threadbase-streamer/CLAUDE.md` — add a one-paragraph note under "Dependencies" or a new "Menubar packaging" section pointing to the submodule's docs.
- Add a `docs/menubar-release.md` in `threadbase-streamer` with a short release runbook: bump version → `npm run package:win`/`:mac` → smoke test → publish artifact (where? — clarify with maintainer; out of scope to set up a release host).

## 8. Out of scope (call out explicitly in your PR description)

- **Code signing.** Windows EV cert and Apple Developer ID are organizational decisions. Leave `signtoolOptions` and `osxSign` configuration commented out with TODO markers.
- **Notarization.** Same reasoning. Commented stub for `afterSign` hook is acceptable.
- **Autoupdate.** electron-builder ships with `electron-updater`; do not wire it up yet — it requires a release feed URL we don't have.
- **Linux.** Config must not break it, but no `linux` target in `build` for now.
- **Cross-compilation.** Build Windows artifacts on a Windows host, macOS on a Mac. Cross-compiling Mac builds from Linux/Windows is possible but adds toolchain complexity (Wine, dmg-license, etc.) — not worth it here.

## 9. Decisions I want you to surface, not silently make

If any of these come up, **stop and ask** rather than picking:

- The icon assets — if none exist, do not commit a placeholder you generated; ask first.
- The Electron major version bump from `^28` (current) — confirm whether to upgrade now or stay.
- Whether the macOS target is universal or split arm64/x64 — has size implications for downloads.
- Where to host the packaged artifacts (S3? GitHub Releases? internal share?) — affects the `publish` block in `build`.

## 10. Definition of done

- [ ] All §3 acceptance criteria pass.
- [ ] All §5 test-matrix items pass on a real Windows machine and a real Mac.
- [ ] §6 deploy-script integration works end to end.
- [ ] §7 docs updated, including removal of the now-stale CLAUDE.md hint.
- [ ] PR description lists every §8 out-of-scope item explicitly so reviewers know what's deferred.
- [ ] No regressions to `npm start` dev workflow.
- [ ] Commit messages follow the repo's conventional-commits style (`feat:`, `chore:`, etc.).

Report back when each phase (renderer-path fix → electron-builder config → Windows build → macOS build → deploy-script wiring → docs) is verified. Do not batch — I want to review the renderer-path fix in isolation before you proceed to packaging, because that change has the highest regression risk.
