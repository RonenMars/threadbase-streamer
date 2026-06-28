## [1.18.5](https://github.com/RonenMars/threadbase-streamer/compare/v1.18.4...v1.18.5) (2026-06-28)

### Bug Fixes

* **lint:** bump biome schema to 2.5.0 and sort swap.ts imports ([1d37e60](https://github.com/RonenMars/threadbase-streamer/commit/1d37e60f344930b671fb6702b452f6b2d3ef2d56)), closes [#140](https://github.com/RonenMars/threadbase-streamer/issues/140)

## [1.18.4](https://github.com/RonenMars/threadbase-streamer/compare/v1.18.3...v1.18.4) (2026-06-28)

### Bug Fixes

* **updater:** sync cli.js on macOS/Linux after swapCurrent (same launch.cmd conflict as Windows) ([69660a0](https://github.com/RonenMars/threadbase-streamer/commit/69660a05df5065a44328413ddce652a8d3e20db2))

## [1.18.3](https://github.com/RonenMars/threadbase-streamer/compare/v1.18.2...v1.18.3) (2026-06-28)

### Bug Fixes

* **updater:** sync cli.js after Windows swapCurrent to unify launch.cmd entry point ([dc6e184](https://github.com/RonenMars/threadbase-streamer/commit/dc6e1845df3810bedfcab7526297f20f4d1de450))

## [1.18.2](https://github.com/RonenMars/threadbase-streamer/compare/v1.18.1...v1.18.2) (2026-06-28)

### Bug Fixes

* **auto-update:** fix install-auto-update.ps1 on Windows ([#139](https://github.com/RonenMars/threadbase-streamer/issues/139)) ([eb362d3](https://github.com/RonenMars/threadbase-streamer/commit/eb362d380c4ba4dcbf537ee97da35c5514c1c08b))

## [1.18.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.18.0...v1.18.1) (2026-06-26)

### Bug Fixes

* **lifecycle:** auto-restore prod when userHeld marker has dead devPid ([ae7c924](https://github.com/RonenMars/threadbase-streamer/commit/ae7c924d67aa760111bfe60b79c40987d7952bd4))

## [1.18.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.17.1...v1.18.0) (2026-06-25)

### Features

* **codex:** read-only codex-cli provider support ([#124](https://github.com/RonenMars/threadbase-streamer/issues/124)) ([bd7e98b](https://github.com/RonenMars/threadbase-streamer/commit/bd7e98bbf63ab50fce1133fa040c6102e73eb9e9))

## [1.17.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.17.0...v1.17.1) (2026-06-23)

### Bug Fixes

* **lifecycle:** skip stale dev-takeover marker when its pid is dead ([#128](https://github.com/RonenMars/threadbase-streamer/issues/128)) ([1aa3099](https://github.com/RonenMars/threadbase-streamer/commit/1aa309969fe3c72d473863c10f33b83abcee7b32))

## [1.17.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.16.1...v1.17.0) (2026-06-23)

### Features

* **conversations:** structured AskUserQuestion streaming ([#123](https://github.com/RonenMars/threadbase-streamer/issues/123)) ([7ed083d](https://github.com/RonenMars/threadbase-streamer/commit/7ed083dd575d6a2b1ff69abf4c27259b32f8ba86))

## [1.16.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.16.0...v1.16.1) (2026-06-22)

### Bug Fixes

* **server:** serve count?refresh=1 from cache, reconcile in background ([#127](https://github.com/RonenMars/threadbase-streamer/issues/127)) ([154092a](https://github.com/RonenMars/threadbase-streamer/commit/154092aefa2222ec2ba61d02ca63e96daddf280a))

## [1.16.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.15.4...v1.16.0) (2026-06-21)

### Features

* **api:** add POST /api/sessions/:id/stop with ndjson progress stream ([#122](https://github.com/RonenMars/threadbase-streamer/issues/122)) ([ab84140](https://github.com/RonenMars/threadbase-streamer/commit/ab84140987f3385e7f7aef33b0548be2d61e896c))

## [1.15.4](https://github.com/RonenMars/threadbase-streamer/compare/v1.15.3...v1.15.4) (2026-06-19)

### Bug Fixes

* **cli:** resolve version.txt through shim symlinks ([#115](https://github.com/RonenMars/threadbase-streamer/issues/115)) ([baed919](https://github.com/RonenMars/threadbase-streamer/commit/baed919a24b3414743d87fb2a897cf2ff85b39dc))

## [1.15.3](https://github.com/RonenMars/threadbase-streamer/compare/v1.15.2...v1.15.3) (2026-06-19)

### Bug Fixes

* **server:** broadcast existing JSONL lines immediately on watcher wire ([af6ddce](https://github.com/RonenMars/threadbase-streamer/commit/af6ddcefb289947daf67dd13c99594e98ccadd07))

## [1.15.2](https://github.com/RonenMars/threadbase-streamer/compare/v1.15.1...v1.15.2) (2026-06-19)

### Bug Fixes

* **server:** fallback to recently-modified JSONL when session UUID differs on resume ([8011ea2](https://github.com/RonenMars/threadbase-streamer/commit/8011ea2c41c4ba7412af5eb3b81dc60ee69b85d1))

## [1.15.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.15.0...v1.15.1) (2026-06-18)

### Performance Improvements

* **resume:** respond immediately, enrich session from SQLite in background ([#112](https://github.com/RonenMars/threadbase-streamer/issues/112)) ([14e674c](https://github.com/RonenMars/threadbase-streamer/commit/14e674cbc0edb262e150e3bc99ad89a1bc5de5f7))

## [1.15.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.14.0...v1.15.0) (2026-06-18)

### Features

* **release:** publish @threadbase-sh/streamer to public npm ([bc3a7ba](https://github.com/RonenMars/threadbase-streamer/commit/bc3a7ba7d7f783c5082ab7bb6a287208cf656da0))
* **watcher:** debounce and batch the conversation file-watching pipeline ([#91](https://github.com/RonenMars/threadbase-streamer/issues/91)) ([61f6478](https://github.com/RonenMars/threadbase-streamer/commit/61f64789f54ebeda2b5f959800eed39d6f53662d)), closes [RonenMars/threadbase-scanner#21](https://github.com/RonenMars/threadbase-scanner/issues/21)
* **ws:** broadcast scan_progress events during startup scan ([#90](https://github.com/RonenMars/threadbase-streamer/issues/90)) ([bc5376e](https://github.com/RonenMars/threadbase-streamer/commit/bc5376e3dd3175f822da5e157ae7cb4e9c7ea3e9))

### Bug Fixes

* **browse:** return 404 PATH_NOT_FOUND for missing in-root browse paths ([#89](https://github.com/RonenMars/threadbase-streamer/issues/89)) ([bb8453b](https://github.com/RonenMars/threadbase-streamer/commit/bb8453b8d9ad2b6f800827f072dbf48d0d8f7903))
* **cache:** surface warm-up tail-skip ids at info level ([#97](https://github.com/RonenMars/threadbase-streamer/issues/97)) ([d17ae71](https://github.com/RonenMars/threadbase-streamer/commit/d17ae713ec928c805fe887a0b47fff6758385546))
* **lifecycle:** clear prod logs by default on start and restart ([#105](https://github.com/RonenMars/threadbase-streamer/issues/105)) ([7449305](https://github.com/RonenMars/threadbase-streamer/commit/7449305f9933a54ff27cef4440b497f72538aa7e)), closes [#103](https://github.com/RonenMars/threadbase-streamer/issues/103)
* **lifecycle:** make `prod start` recover an agent unloaded by `prod stop` ([#93](https://github.com/RonenMars/threadbase-streamer/issues/93)) ([c99fecd](https://github.com/RonenMars/threadbase-streamer/commit/c99fecdd4c6a09f161f6a58a95152ff3d23de7a6))
* **server:** downgrade EADDRINUSE bind noise to debug ([#96](https://github.com/RonenMars/threadbase-streamer/issues/96)) ([09bacc2](https://github.com/RonenMars/threadbase-streamer/commit/09bacc245a0bd09ce281686a37ee50336fd36919))
* **server:** skip full-tree rescan on the conversation-detail path ([#104](https://github.com/RonenMars/threadbase-streamer/issues/104)) ([ec29407](https://github.com/RonenMars/threadbase-streamer/commit/ec29407bc642242fa277126ce5b2f47cf071f81a)), closes [#98](https://github.com/RonenMars/threadbase-streamer/issues/98)

## [1.14.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.13.4...v1.14.0) (2026-06-18)

### Features

* **deps:** consume scanner + agent-types from [@threadbase-sh](https://github.com/threadbase-sh) npm ([#100](https://github.com/RonenMars/threadbase-streamer/issues/100)) ([501fb3c](https://github.com/RonenMars/threadbase-streamer/commit/501fb3c6e41c79a4a38f0dc8cbf98837f7ec727f))

## [1.13.4](https://github.com/RonenMars/threadbase-streamer/compare/v1.13.3...v1.13.4) (2026-06-17)

### Bug Fixes

* **test:** eliminate TOCTOU port race in webhook-update tests ([#88](https://github.com/RonenMars/threadbase-streamer/issues/88)) ([749e6b5](https://github.com/RonenMars/threadbase-streamer/commit/749e6b5490af0994c888ebfd81faee7dc596e178))

## [1.13.3](https://github.com/RonenMars/threadbase-streamer/compare/v1.13.2...v1.13.3) (2026-06-17)

### Bug Fixes

* **uploads:** convert HEIC to JPEG and preserve Unicode filenames ([#86](https://github.com/RonenMars/threadbase-streamer/issues/86)) ([82057a1](https://github.com/RonenMars/threadbase-streamer/commit/82057a1eceb543be14096742c811c94f8a5aea58))

## [1.13.2](https://github.com/RonenMars/threadbase-streamer/compare/v1.13.1...v1.13.2) (2026-06-17)

### Bug Fixes

* **discovery:** fall back to now() when ps lstart= is unparseable ([#87](https://github.com/RonenMars/threadbase-streamer/issues/87)) ([3c75f76](https://github.com/RonenMars/threadbase-streamer/commit/3c75f76cebe6ece707460a356b868b17067ee265))

## [1.13.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.13.0...v1.13.1) (2026-06-17)

### Bug Fixes

* accept any mime type for uploads ([#85](https://github.com/RonenMars/threadbase-streamer/issues/85)) ([c6ead86](https://github.com/RonenMars/threadbase-streamer/commit/c6ead86a178c7efe6f1aeb64ebe3980f10d68ce9))

## [1.13.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.12.1...v1.13.0) (2026-06-17)

### Features

* **ws:** unicast session_list to the initiating client via X-Client-Id ([#84](https://github.com/RonenMars/threadbase-streamer/issues/84)) ([b26a3b0](https://github.com/RonenMars/threadbase-streamer/commit/b26a3b0ebfaf7648c03095bfbfdc92e3f6c5622e))

## [1.12.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.12.0...v1.12.1) (2026-06-17)

### Bug Fixes

* **test:** replace non-null assertion with optional chaining in getFileStats test ([8d9ee5f](https://github.com/RonenMars/threadbase-streamer/commit/8d9ee5fbb44287f43fdd4f517eb7c8449db748ec))

## [1.12.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.11.1...v1.12.0) (2026-06-17)

### Features

* **cache:** skip unchanged files in scanner using stat-based cache ([#78](https://github.com/RonenMars/threadbase-streamer/issues/78)) ([e95b06c](https://github.com/RonenMars/threadbase-streamer/commit/e95b06cdc184bc1a9481e4200e47b4ec457941a4))

## [1.11.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.11.0...v1.11.1) (2026-06-17)

### Bug Fixes

* **ws:** replace JSON ping with WS protocol ping/pong heartbeat ([#83](https://github.com/RonenMars/threadbase-streamer/issues/83)) ([1255abb](https://github.com/RonenMars/threadbase-streamer/commit/1255abb389491c8677058534c7b7a53dc7e65ece))

## [1.11.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.10.3...v1.11.0) (2026-06-17)

### Features

* **ci:** auto-merge scanner bump PR once CI is green ([#80](https://github.com/RonenMars/threadbase-streamer/issues/80)) ([06625d2](https://github.com/RonenMars/threadbase-streamer/commit/06625d2ecfa68e1f88ec0bc750ce6b049c6acabb))

## [1.10.3](https://github.com/RonenMars/threadbase-streamer/compare/v1.10.2...v1.10.3) (2026-06-15)

### Bug Fixes

* **server:** retry HTTP bind on transient EADDRINUSE during restart ([#76](https://github.com/RonenMars/threadbase-streamer/issues/76)) ([a739ba5](https://github.com/RonenMars/threadbase-streamer/commit/a739ba57c9c2620a1f456040bdb5cc4333a25d86)), closes [#75](https://github.com/RonenMars/threadbase-streamer/issues/75) [#75](https://github.com/RonenMars/threadbase-streamer/issues/75)

## [1.10.2](https://github.com/RonenMars/threadbase-streamer/compare/v1.10.1...v1.10.2) (2026-06-15)

### Bug Fixes

* **server:** force-close sockets on shutdown to release port for redeploy ([#75](https://github.com/RonenMars/threadbase-streamer/issues/75)) ([8d03847](https://github.com/RonenMars/threadbase-streamer/commit/8d03847077b0de2e5ffa1039d7cec6d23c802ffb))

## [1.10.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.10.0...v1.10.1) (2026-06-15)

### Bug Fixes

* **conversations:** serve single-conversation reads without a cold full scan ([#74](https://github.com/RonenMars/threadbase-streamer/issues/74)) ([8aec961](https://github.com/RonenMars/threadbase-streamer/commit/8aec9611fe3d5012e8605150b3f701a0dd2a20f8)), closes [RonenMars/threadbase-scanner#16](https://github.com/RonenMars/threadbase-scanner/issues/16)

## [1.10.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.9.3...v1.10.0) (2026-06-15)

### Features

* **lifecycle:** support homebrew --prod via runtime label resolution ([#71](https://github.com/RonenMars/threadbase-streamer/issues/71)) ([2eac9a4](https://github.com/RonenMars/threadbase-streamer/commit/2eac9a4d77f3973248f79778553400773490396b)), closes [#70](https://github.com/RonenMars/threadbase-streamer/issues/70) [69/#70](https://github.com/69/threadbase-streamer/issues/70)

### Bug Fixes

* **release:** push release commit with admin PAT to satisfy main ruleset ([#72](https://github.com/RonenMars/threadbase-streamer/issues/72)) ([f67a27b](https://github.com/RonenMars/threadbase-streamer/commit/f67a27b728b1b028909772c20582541130f97a2d)), closes [#69](https://github.com/RonenMars/threadbase-streamer/issues/69) [#69](https://github.com/RonenMars/threadbase-streamer/issues/69) [pre-#69](https://github.com/RonenMars/pre-/issues/69)
* **updater:** detect homebrew install for service restart and update ([#70](https://github.com/RonenMars/threadbase-streamer/issues/70)) ([08bad50](https://github.com/RonenMars/threadbase-streamer/commit/08bad50d9644bb75408958445fea1c461887daf4)), closes [#69](https://github.com/RonenMars/threadbase-streamer/issues/69) [#69](https://github.com/RonenMars/threadbase-streamer/issues/69)

## [1.2.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.2.0...v1.2.1) (2026-06-01)

### Bug Fixes

* **test:** stop setApiKey tests clobbering real config on Windows; gate win32-incompatible assertions ([a89601f](https://github.com/RonenMars/threadbase-streamer/commit/a89601f39c858fb1b6981b9067de5bb754c33b5e))

## [1.2.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.1.2...v1.2.0) (2026-05-31)

### Features

* ship tb-streamer via a Homebrew tap ([#7](https://github.com/RonenMars/threadbase-streamer/issues/7)) ([1210f59](https://github.com/RonenMars/threadbase-streamer/commit/1210f59c537b2d46e64c7572a2ba6ba5f1cde27b))

## [1.1.2](https://github.com/RonenMars/threadbase-streamer/compare/v1.1.1...v1.1.2) (2026-05-31)

### Bug Fixes

* **updater:** resolve download target parent dir with dirname() ([1e4e635](https://github.com/RonenMars/threadbase-streamer/commit/1e4e635978b9fdfe4f2f5ed0da68475bb846f709))

## [1.1.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.1.0...v1.1.1) (2026-05-31)

### Bug Fixes

* **deploy:** auto-rebuild better-sqlite3 on ABI ([ae7aa06](https://github.com/RonenMars/threadbase-streamer/commit/ae7aa06e433d7292e6753624408e4f9506a9633a))

## [1.1.0](https://github.com/RonenMars/threadbase-streamer/compare/v1.0.1...v1.1.0) (2026-05-31)

### Features

* **deploy:** install threadbase-streamer and tb-streamer global commands ([a605745](https://github.com/RonenMars/threadbase-streamer/commit/a605745749451bcd6e8e621636e0d7421ef32e5e))
* filter agent conversations from cache via entrypoint marker ([#4](https://github.com/RonenMars/threadbase-streamer/issues/4)) ([fda9e2a](https://github.com/RonenMars/threadbase-streamer/commit/fda9e2ab0deb3eded2cd3c8c44a37fddd8702304))
* prod/dev lifecycle coordination (macOS launchd + Windows Task Scheduler) ([#5](https://github.com/RonenMars/threadbase-streamer/issues/5)) ([419d5df](https://github.com/RonenMars/threadbase-streamer/commit/419d5df4bd7479d30917f14af73d8b73df322883))
* **remote-access:** add docs hub + Cloudflare quick-tunnel onboarding ([03c0ab6](https://github.com/RonenMars/threadbase-streamer/commit/03c0ab6d0b96515d908b15b9deca66f6e3928276))

### Bug Fixes

* backfill project context for skeleton conversation cache rows ([#3](https://github.com/RonenMars/threadbase-streamer/issues/3)) ([93e93ff](https://github.com/RonenMars/threadbase-streamer/commit/93e93ff1c4aefbd4b02f50bf4a2bd0df021b5a22))
* **cli:** align default port to 8766 across serve/pair/update ([b48f97b](https://github.com/RonenMars/threadbase-streamer/commit/b48f97b0cc18690bf9ff46f860986dd10e8cd3bb))
* **pty:** queue input on resume until prompt marker — closes "dot bug" ([d115084](https://github.com/RonenMars/threadbase-streamer/commit/d115084492a20e1af19676485419e3fab679a0a1))
* **pty:** render PTY through headless terminal for in-order replay ([882d4df](https://github.com/RonenMars/threadbase-streamer/commit/882d4df54311d47d84b86cb3228027fe005ad655))
* **pty:** split paste and \r across two writes so TUI mid-render does not swallow submit ([cadf4d2](https://github.com/RonenMars/threadbase-streamer/commit/cadf4d2ba0a10adb25835cae4d6d1d1449cb9e5f))

## [1.0.1](https://github.com/RonenMars/threadbase-streamer/compare/v1.0.0...v1.0.1) (2026-05-23)

### Bug Fixes

* detect cache drift for /project-chats via orphan rows + disk mtime ([71bc383](https://github.com/RonenMars/threadbase-streamer/commit/71bc38387f43d47c62e3055ca1f8357573f8042e))

## 1.0.0 (2026-05-20)

### Features

* add 5s TTL cache for process discovery in /api/sessions ([71897f4](https://github.com/RonenMars/threadbase-streamer/commit/71897f4c720db526d1b2e500c3dd75a7f5e40346))
* add adopt endpoint to kill disc_ process and resume as managed session ([f1f4de2](https://github.com/RonenMars/threadbase-streamer/commit/f1f4de2abdc0eaa167b69553e86cbb0f4503ff6a))
* add browse path resolver with directory listing and mkdir ([034435c](https://github.com/RonenMars/threadbase-streamer/commit/034435c861e8bf70d9fb6652cc4a835d7fba17bf))
* add BROWSE_ROOT_NOT_SET error code to browse endpoints ([14b8656](https://github.com/RonenMars/threadbase-streamer/commit/14b86561e7ec6b31f55fbfcdca5154c8d737ff2a))
* add browseRoot config type, YAML loader, and CLI flag ([f03e32c](https://github.com/RonenMars/threadbase-streamer/commit/f03e32c125ba2c5824d455643214c97aceec497f))
* add cache clear CLI command; document stale-cache troubleshooting ([604827c](https://github.com/RonenMars/threadbase-streamer/commit/604827c57c4b898d9ee0cd6d2deba04057b12425))
* add cacheDir and tailSize config fields ([1f4c81e](https://github.com/RonenMars/threadbase-streamer/commit/1f4c81e4282a705481225332f317a29395210de5))
* add failureReason to sessions for fast-exit diagnostics ([62ee39e](https://github.com/RonenMars/threadbase-streamer/commit/62ee39ecb932012d84a50682fb18f07ecaa70322))
* add GET /api/browse and POST /api/browse/mkdir endpoints ([9b6a142](https://github.com/RonenMars/threadbase-streamer/commit/9b6a14210baf06175926c75305c28c4e0edb524e))
* add GET /api/projects/popular endpoint ([04c85fa](https://github.com/RonenMars/threadbase-streamer/commit/04c85fac50e09806f9834e73b3af3e0cd3cc21f2))
* add GET /api/sessions/recents endpoint ([fbe213b](https://github.com/RonenMars/threadbase-streamer/commit/fbe213b2382f8a81f79aad6a7861f4a4cb3fee66))
* add getPopularProjects to ConversationCache ([821a403](https://github.com/RonenMars/threadbase-streamer/commit/821a403dc1235cf5c8ba990f2b6f1e0159efe0b8))
* add killPid helper to PTYManager ([ed48d94](https://github.com/RonenMars/threadbase-streamer/commit/ed48d94c950b844d1aa6d01b48fcfb2c0322458e))
* add optional PostgreSQL persistence for managed sessions ([50cf9cb](https://github.com/RonenMars/threadbase-streamer/commit/50cf9cbbe61924a3bc5a0cdff7ee939509aa288c))
* add POST /api/sessions/start for fresh Claude sessions with system prompt ([6669258](https://github.com/RonenMars/threadbase-streamer/commit/6669258ef929ced975fb4c96bd923170011bcfe3))
* **api:** add /conversations/count and /sessions/count endpoints ([80e3fba](https://github.com/RonenMars/threadbase-streamer/commit/80e3fbaba866024dfc6326a479e5bce282e2a156))
* **api:** add mobile pairing endpoints and QR code support ([0fe7dfb](https://github.com/RonenMars/threadbase-streamer/commit/0fe7dfb85aebd2de18cc74bb694b3d2c7a1dc412))
* auto-deploy menubar in all deploy scripts when submodule SHA changes ([51399b3](https://github.com/RonenMars/threadbase-streamer/commit/51399b32daaeee0cf284557e666c96c4081eb24e))
* **cli:** add cross-platform `tb` launcher shim ([9f7cad0](https://github.com/RonenMars/threadbase-streamer/commit/9f7cad0fe8c7041c7d5e7b268d6af9448c3e1ae2))
* **deploy:** --publish-menubar flag + menubar subcommand + LS fix ([8c04692](https://github.com/RonenMars/threadbase-streamer/commit/8c0469242a603d8f031234a9a061526849410347))
* **deploy:** add scripts/deploy.sh with release stamping and rollback ([c7e9127](https://github.com/RonenMars/threadbase-streamer/commit/c7e9127faa18ebe40c5fb92d57880a402943ad12))
* **deploy:** add setup subcommand — creates service file and asks about auto-startup ([8ea90f9](https://github.com/RonenMars/threadbase-streamer/commit/8ea90f9d34dcf295fca94d18d71e80e335c03a56))
* **deploy:** install menubar from packaged .dmg, not source tree ([4590be6](https://github.com/RonenMars/threadbase-streamer/commit/4590be6eac903938a1a962a36febc8a8cfee19d2))
* **deploy:** prompt for browse_root if not configured in server.yaml ([36b28d4](https://github.com/RonenMars/threadbase-streamer/commit/36b28d46709442787738dccf725e64ac4bd2af4b))
* **deploy:** wire Cloudflare tunnel and document CF Access nuances ([1454883](https://github.com/RonenMars/threadbase-streamer/commit/1454883e750b0e1e374ed2b74dcaf42ff56e2aea))
* enrich sessions with conversation metadata ([2a52870](https://github.com/RonenMars/threadbase-streamer/commit/2a52870229daa83a09017c26d159e6c7d672c2a3))
* expose filePath, preview, account, firstMessage, lastMessage in conversation API ([804feac](https://github.com/RonenMars/threadbase-streamer/commit/804feac5329500fad4414c004d1bb0e4a30c3c69))
* forward scanner fields through REST API to mobile clients ([8afbe65](https://github.com/RonenMars/threadbase-streamer/commit/8afbe655df02b6363a2fff3e2e4580f93a652ee1))
* implement ConversationCache with SQLite ([3d3a8ac](https://github.com/RonenMars/threadbase-streamer/commit/3d3a8ace731b712cd4d6caee8a7354c8d2611391))
* in-place auto-update from GitHub Releases ([#2](https://github.com/RonenMars/threadbase-streamer/issues/2)) ([6c1057e](https://github.com/RonenMars/threadbase-streamer/commit/6c1057ecf289b4c42e793a8bb17323ae27ab7bf9)), closes [#26122222339](https://github.com/RonenMars/threadbase-streamer/issues/26122222339)
* include sessionName (slug) in conversation list and search responses ([e503afc](https://github.com/RonenMars/threadbase-streamer/commit/e503afc2609d8d2745a5174edfef53658438e10d))
* include tool-result messages and expose uuid + is_tool_result ([5a87751](https://github.com/RonenMars/threadbase-streamer/commit/5a8775131eedb728d2e17606a7681432477c5f86))
* initial @threadbase/streamer v0.1.0 ([2b9055a](https://github.com/RonenMars/threadbase-streamer/commit/2b9055a23c2875dad3ddad93223954b7fdfd7cdd))
* **package:** add alias 'tb' for threadbase-streamer CLI ([3379cae](https://github.com/RonenMars/threadbase-streamer/commit/3379cae9f9fed7c3d3fc282180f945cabee139c2))
* populate conversation tail from JSONL on startup ([af21ef3](https://github.com/RonenMars/threadbase-streamer/commit/af21ef341ffa5c2f7c0614f43a0d088ed84fca13))
* push terminal history over WS and add session_ready signal ([30c1835](https://github.com/RonenMars/threadbase-streamer/commit/30c1835833828fe08e88932dbf50c7e3cbc1b775))
* push terminal history over WS and add session_ready signal ([b96e1a8](https://github.com/RonenMars/threadbase-streamer/commit/b96e1a89c2f77ff31511b49e2cae5f7a580be393))
* scope sessions by instance_id for multi-server support ([8cb1187](https://github.com/RonenMars/threadbase-streamer/commit/8cb1187c6bbc1acadbd49b2d545d06623e0313a4))
* serve /api/conversations and /count from SQLite cache ([c55cf70](https://github.com/RonenMars/threadbase-streamer/commit/c55cf704576a769d95a6553596c957e246410576))
* serve conversation tail from SQLite cache ([b840c28](https://github.com/RonenMars/threadbase-streamer/commit/b840c2858b92ab04b041636cebac38706abdcbec))
* **server:** expose /healthz endpoint and bake build version into binary ([e60289e](https://github.com/RonenMars/threadbase-streamer/commit/e60289ee18331ba3cf8076b6c7babd799ab91c7c))
* **sessions:** add on_hold status and idle sweep ([3b68178](https://github.com/RonenMars/threadbase-streamer/commit/3b681787e23646529da700fb8f05db765001437a))
* **skills:** add local-deploy project skill ([9c0c2eb](https://github.com/RonenMars/threadbase-streamer/commit/9c0c2eb3f48566ac0b5a8bd5649c0ed6c0b40275))
* **skills:** grow local-deploy to cross-platform (Linux + Windows) ([a0457b8](https://github.com/RonenMars/threadbase-streamer/commit/a0457b882cc6d279f7cf9f7c18bdfa34390195f3))
* **streamer:** add cursor-paginated GET /api/sessions envelope ([7116f78](https://github.com/RonenMars/threadbase-streamer/commit/7116f78b7be8f57c3c34460d5213a108e99e014f))
* **streamer:** add PATCH /api/sessions/:id/name and GET /api/sessions/names ([54db998](https://github.com/RonenMars/threadbase-streamer/commit/54db9986c5037068bbfcac60b9ff0d8be3a42e3e))
* **streamer:** add QR pairing with sealed-box E2E exchange ([ede9274](https://github.com/RonenMars/threadbase-streamer/commit/ede9274217a9001570ddaf698f108c8b352871a5))
* **streamer:** add session file upload endpoint with DB tracking ([581d106](https://github.com/RonenMars/threadbase-streamer/commit/581d106d352e28a1935e57045c547a1927e3e46a))
* **streamer:** add session_names table and ConversationCache methods ([10db4f5](https://github.com/RonenMars/threadbase-streamer/commit/10db4f50a642cc942f0b4ceba630eb89a2d5065b))
* **streamer:** pass --dangerously-skip-permissions to claude PTY ([90577ae](https://github.com/RonenMars/threadbase-streamer/commit/90577ae479fbdd657f19ae7d9538b15a70de3683))
* **streamer:** projects-as-identity refactor + /project-chats endpoint ([f44a81f](https://github.com/RonenMars/threadbase-streamer/commit/f44a81f82c89df46c52dd82b9f0f36f95a3ae2d5))
* **streamer:** reconcile orphaned sessions and backfill conversationId on startup ([5e3cc30](https://github.com/RonenMars/threadbase-streamer/commit/5e3cc3083672894aa4d7df747ad83a82fea40d9b))
* **streamer:** structured logging via pino + pino-http ([830e501](https://github.com/RonenMars/threadbase-streamer/commit/830e5015a923a704a0ab661f2b3bedd870aa2127))
* unified session identity — JSONL UUID as single source of truth ([66a49e6](https://github.com/RonenMars/threadbase-streamer/commit/66a49e6c7f1a50e61c4d2f1d88ecda48afc252cf))
* unified session identity — JSONL UUID as single source of truth ([76cdf9f](https://github.com/RonenMars/threadbase-streamer/commit/76cdf9f20b8ae144753dc3d1d450fd0d8f801a82))
* Windows menubar support — centered popup, close button, deploy skill ([652e796](https://github.com/RonenMars/threadbase-streamer/commit/652e796a765977828b6bfc904276bd42e5992d37))
* wire ConversationCache into server startup and FileWatcher ([4de8e58](https://github.com/RonenMars/threadbase-streamer/commit/4de8e58504a8e3b03b901b07e2a8781135f5c949))

### Bug Fixes

* accept rename events in FileWatcher for Windows fs.watch compatibility ([4575c5c](https://github.com/RonenMars/threadbase-streamer/commit/4575c5ced382a49f54f26b6985236dac65d4e0d7))
* add conversationId to SessionResponse for mobile deep-link navigation ([9058cc6](https://github.com/RonenMars/threadbase-streamer/commit/9058cc65757cc0e28af66f86b17fcd2203157080))
* align search test with actual response shape ([f655f7f](https://github.com/RonenMars/threadbase-streamer/commit/f655f7f31a31e4389d83689a701dd328af68d189))
* **api:** return empty output instead of 404 for untracked sessions ([5da6401](https://github.com/RonenMars/threadbase-streamer/commit/5da6401fb3afbf4d32577f00b5270e49e1f2093e))
* bump biome schema to 2.4.13, replace non-null assertions, raise hookTimeout to 30s ([42e20d7](https://github.com/RonenMars/threadbase-streamer/commit/42e20d7f7957f129463e1aa92fe77d33b9ef1867))
* cache fetching ([2dc1c97](https://github.com/RonenMars/threadbase-streamer/commit/2dc1c9700cfba4fb95c7613e40c80ef473e3c6e1))
* cached scanner, search format, tool result filtering, discovered session output, node-pty bundling ([5370f31](https://github.com/RonenMars/threadbase-streamer/commit/5370f312af688454b404bb07d138871322d0e037))
* change CLI output extension from .js to .cjs ([69e3e37](https://github.com/RonenMars/threadbase-streamer/commit/69e3e37c664e750bb29c2ec5fd71b20ef7a2d47a))
* **ci:** build scanner dependency before streamer install ([471fd67](https://github.com/RonenMars/threadbase-streamer/commit/471fd67bb7a78701ba17646a9568de7470842c3d))
* **ci:** clone scanner into vendor/scanner instead of using submodule token ([b856c0d](https://github.com/RonenMars/threadbase-streamer/commit/b856c0d4a6241893e6860ecf87f0f8e0cc084eb0))
* **ci:** init submodules via checkout instead of manual clone ([0a9d4a1](https://github.com/RonenMars/threadbase-streamer/commit/0a9d4a12a77903fc2134d2df3e063c2ba34a8d8b))
* **ci:** use actions/checkout with PAT to clone private scanner repo ([3c11db1](https://github.com/RonenMars/threadbase-streamer/commit/3c11db1e9ea44a15019bba7b0e6a1e4f80c51681))
* **ci:** use git clone with token env var for scanner checkout ([af44160](https://github.com/RonenMars/threadbase-streamer/commit/af44160181c7f0f92033ad570110416f33ea5db2))
* copy better-sqlite3 and transitive deps in macOS deploy script ([f6f62ec](https://github.com/RonenMars/threadbase-streamer/commit/f6f62ec11786a1b4a5ce44872f2965a5b4bd1d1c))
* copy bindings and file-uri-to-path alongside better-sqlite3 in deploy scripts ([551575a](https://github.com/RonenMars/threadbase-streamer/commit/551575a6c78ac2b1bc2c7ba29fa2dee3cbabc4b6))
* copy node-pty to releases/node_modules in Unix deploy scripts ([455efe7](https://github.com/RonenMars/threadbase-streamer/commit/455efe73cdc4d7afbf4d2b8f79126e2c0d183ea2))
* correct cache upsert sentinel — scanner writes use 0, updateFromLine wins with Date.now() ([4db95b0](https://github.com/RonenMars/threadbase-streamer/commit/4db95b0bd2178693c8f222cf1e30533c6d98c273))
* deduplicate discovered sessions that match a managed session ([14b1ce9](https://github.com/RonenMars/threadbase-streamer/commit/14b1ce95f12a8484b5b6fa294bc3dfd2a0ae6600))
* **deploy-linux:** pass --port and --verbose in systemd ExecStart ([f4222c7](https://github.com/RonenMars/threadbase-streamer/commit/f4222c7707c23461b55721af322c3801941c0078))
* **deploy:** bundle pg in CLI and copy migrations to releases dir ([5c8426a](https://github.com/RonenMars/threadbase-streamer/commit/5c8426aab40987c1032be9989a575ddf728a435b))
* **deploy:** clean migrations dirs before copying ([9becb93](https://github.com/RonenMars/threadbase-streamer/commit/9becb93409e248e184f5452a10bbf9485018d700))
* **deploy:** copy migrations in Windows+Linux scripts; document Windows gotchas ([e8c9ac3](https://github.com/RonenMars/threadbase-streamer/commit/e8c9ac32c49f036276da813d458ba035995a515f))
* **deploy:** copy migrations to install root on Windows, not releases/ ([bebd351](https://github.com/RonenMars/threadbase-streamer/commit/bebd351f52fc221829436684846b0adf4372ac27))
* **deploy:** launch Windows task via wscript shim to suppress console flash ([7823895](https://github.com/RonenMars/threadbase-streamer/commit/7823895c18c3cfc6e4dab6ad802c91ed601e7fdd))
* **deploy:** menubar launch no longer leaves zombie deploy.sh in bash 5.3+ ([f95998f](https://github.com/RonenMars/threadbase-streamer/commit/f95998f7d1963b9991f6cafd87a3ef7dba32cba1))
* **deploy:** ship pg-migrations and wipe stale migration dirs before copy ([68803b9](https://github.com/RonenMars/threadbase-streamer/commit/68803b9978b64c7730ec47030e40d78bbbdbd92e))
* detect ❯ as ready marker and add 10s fallback to flush queued input ([65c9c73](https://github.com/RonenMars/threadbase-streamer/commit/65c9c733450f829849601a21f2418793f97a34b5))
* eliminate pending_ ID and fire session_ready on first prompt ([a8fe90e](https://github.com/RonenMars/threadbase-streamer/commit/a8fe90e72698e84844a40fab4fc0d70fb37741ec))
* enrich cache fast-path meta, filter non-message roles, isolate test caches ([11da6d5](https://github.com/RonenMars/threadbase-streamer/commit/11da6d5623aabeb59bc97815c327120427ca8002))
* ensure node-pty spawn-helper has execute permission ([d3385dd](https://github.com/RonenMars/threadbase-streamer/commit/d3385dd2c07899ce96fbfbfb0a911514c514bee9))
* exclude discovered processes without a JSONL UUID from session list ([daf35c7](https://github.com/RonenMars/threadbase-streamer/commit/daf35c77a0a993585ecb8905d5e3269f9b12ca4a))
* exclude subagent conversations and use sessionId for conversation IDs ([6ca855c](https://github.com/RonenMars/threadbase-streamer/commit/6ca855ce35b589c9896465927413fe5233d0587b))
* exclude untracked files from tsup dirty check ([a64fd6d](https://github.com/RonenMars/threadbase-streamer/commit/a64fd6dea22b212d60c092eab00904ad39a7e305))
* ignore untracked files in predeploy dirty check ([bd29705](https://github.com/RonenMars/threadbase-streamer/commit/bd2970540122fba24bf58fc5fc357c473e3d1ae2))
* keep cache rows with tails on prune; surface warm-up errors ([fcb7a8c](https://github.com/RonenMars/threadbase-streamer/commit/fcb7a8c8e1aee51bf5631d784c6ed466c4ba28c1))
* kill stale port-8766 process in Kickstart before starting task ([104fefb](https://github.com/RonenMars/threadbase-streamer/commit/104fefbb4691416f8b02f15b0737496c309eacf9))
* lint fixups after cache layer integration ([039669b](https://github.com/RonenMars/threadbase-streamer/commit/039669b1d3bbdd541f01f68c29526d3707f650f1))
* mobile API compatibility — field mapping, detail shape, resume lookup, info fields ([fe3e758](https://github.com/RonenMars/threadbase-streamer/commit/fe3e7588b90928a093da85c6d68a792a1691ce68))
* normalize string-form message.content in cache to prevent warm-up crash ([fbfff31](https://github.com/RonenMars/threadbase-streamer/commit/fbfff310c5091da2c77f790081cb41006fc713d0))
* preserve Unix absolute paths in resolveBrowsePath — don't strip leading / ([7effe49](https://github.com/RonenMars/threadbase-streamer/commit/7effe496f6abab6b26aa0fa391b3651781ce8927))
* prune ghost cache rows when JSONLs are deleted ([ac6092d](https://github.com/RonenMars/threadbase-streamer/commit/ac6092d57e92514e1bf2de2c64050ff0409b47a9))
* **pty:** detect Claude prompt to set waiting_input status ([db58e4b](https://github.com/RonenMars/threadbase-streamer/commit/db58e4b1deb20189359164bd39bea0f0622deb6b))
* **pty:** queue inputs received during session boot, flush at first prompt ([59ee708](https://github.com/RonenMars/threadbase-streamer/commit/59ee708ffa2d17404a682702fa787c3e66e5ee0e))
* remove dead disc_pid lookup from session-store get() ([82a7114](https://github.com/RonenMars/threadbase-streamer/commit/82a71148561086e4df70f27edd9b018a181ac942))
* rename getConversationMeta to getMetaById; add getFullById stmt; await scanner ready in tests ([bc9ac35](https://github.com/RonenMars/threadbase-streamer/commit/bc9ac35c3ad03d434cd4127ac9ce0d62e7c9d421))
* resolve all test failures — publicUrl priority, disableDb, sequential test pool ([3c84eea](https://github.com/RonenMars/threadbase-streamer/commit/3c84eeaf0f2618fd7986426aea5a9ee7a1501d4e))
* resolve biome lint and formatting errors in server.ts ([2437ccc](https://github.com/RonenMars/threadbase-streamer/commit/2437ccc56a6ffd01b759d4de5ee8644ad8e506f5))
* resolve Windows path and session-discovery issues ([0e61299](https://github.com/RonenMars/threadbase-streamer/commit/0e612990f02d79cd8bf86db6e94c47c6a830a7ca))
* restore disc_pid fallback for discovered sessions without a UUID ([254e164](https://github.com/RonenMars/threadbase-streamer/commit/254e164bd45a544100bc7a4c4a15a95c9e17c109))
* restore tool_use/tool_result content blocks in cache tail fast-path ([08566bf](https://github.com/RonenMars/threadbase-streamer/commit/08566bfcacd49c6ee8747e2e242e949c6d89b5e8))
* serve cached tail on /api/conversations/:id when msg_limit is set ([5f0382d](https://github.com/RonenMars/threadbase-streamer/commit/5f0382d3e14fa471d3da6ef0ab1ed76e4f09c95d))
* **server:** await scanner readiness to avoid empty-cache race ([e1bd266](https://github.com/RonenMars/threadbase-streamer/commit/e1bd266cf4a75556a73dbacbc3758b8d7413f577))
* **sessions:** /api/sessions/recents reads ConversationCache ([f20b8f7](https://github.com/RonenMars/threadbase-streamer/commit/f20b8f74c314e69143bf1bca8306342e22591362))
* skip discovered processes without conversationId (no more disc_ IDs) ([dedf722](https://github.com/RonenMars/threadbase-streamer/commit/dedf7221e2419793028fad4eff9349dc78d0d1f1))
* **streamer:** launchd plist must set PATH so node-pty can find claude ([ccde4db](https://github.com/RonenMars/threadbase-streamer/commit/ccde4dba62626b7b83105cc926985f6978a58a52))
* **streamer:** send SIGINT instead of SIGHUP when cancelling PTY session ([a4639d0](https://github.com/RonenMars/threadbase-streamer/commit/a4639d02c4cd5960457c64b330b43fc80f3b0b8e))
* support UUID session IDs in adopt endpoint ([77223c5](https://github.com/RonenMars/threadbase-streamer/commit/77223c51ba931e816ac9327853f525a2f7d8c528))
* update adopt handler to use new unified-identity APIs ([6b37046](https://github.com/RonenMars/threadbase-streamer/commit/6b37046c849b44ca662525afe659300e2dfd7b62))
* use \r for PTY input submission and sync promptCount to session store ([dafa58b](https://github.com/RonenMars/threadbase-streamer/commit/dafa58bf010af8892a34701aec2c8fe065e29b8f))
* use request UUID as meta.id in conversation detail response ([e292a20](https://github.com/RonenMars/threadbase-streamer/commit/e292a203cf672bef1da53ddbaea2158fbb2a5ebd))
* Windows claude-exe resolution, windowsHide, path-sep scan fix, troubleshooting docs ([e658f19](https://github.com/RonenMars/threadbase-streamer/commit/e658f193e8649ca405fdb59a41949254ee527292))
* **windows:** use path.sep in browse guard and mtimeMs in reconcile ([585fbf7](https://github.com/RonenMars/threadbase-streamer/commit/585fbf76408bbf428de6071e518319eacf1bcdc3))
* wrap PTY input in bracketed-paste markers to fix @<path> submit ([0938bb2](https://github.com/RonenMars/threadbase-streamer/commit/0938bb2d4f6196159f4e40d1b51adc6af3bba01e))
* **ws:** pass real Hono app reference to createNodeWebSocket ([354c8f2](https://github.com/RonenMars/threadbase-streamer/commit/354c8f29065c50456171a2461e766d77da2741d2))

### Performance Improvements

* make process discovery async to stop blocking the event loop ([d9e2a84](https://github.com/RonenMars/threadbase-streamer/commit/d9e2a84f27a98f6149ea1dc752736623da2f327c))

# Changelog

All notable changes to this project will be documented here. This file is
maintained by [semantic-release](https://semantic-release.gitbook.io/) — do not
edit by hand. Entries are generated from conventional-commits messages on
push to `main` (stable) and `next` (prerelease).
