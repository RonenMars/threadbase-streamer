// Detects whether the running CLI was installed by Homebrew. The built-in
// auto-updater swaps files under ~/.threadbase/, but a brew install runs from
// the Cellar (libexec/) — a location the updater never touches — so the swap
// can't take effect. runInstall() uses this to refuse and point the user at
// `brew upgrade` instead of silently downloading an update that won't apply.
//
// Every Homebrew prefix (Apple Silicon /opt/homebrew, Intel /usr/local,
// linuxbrew /home/linuxbrew/.linuxbrew) installs formulae under `<prefix>/
// Cellar/<formula>/<version>/…`, so a `/Cellar/` path segment is the reliable,
// prefix-independent signal.
export function isBrewInstall(scriptPath: string = process.argv[1] ?? ""): boolean {
  if (!scriptPath) return false;
  return scriptPath.includes("/Cellar/");
}
