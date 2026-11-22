import { mkdir, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { canonicalizeProjectPath } from "./utils/canonicalizeProjectPath";

/**
 * Thrown when a browse target is inside the root but does not exist on disk
 * (e.g. a mobile-cached path whose folder was since moved or deleted). Lets the
 * browse handler answer 404 instead of conflating it with an out-of-root 400.
 */
export class BrowsePathNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowsePathNotFoundError";
  }
}

/**
 * `unrestricted` (the `unrestrictedBrowse` feature flag) drops the out-of-root
 * check: `..` and absolute paths may leave `browseRoot`, which stays only the
 * base that relative paths resolve against. Existence is still checked.
 * A leading `~` means the home directory. Restricted mode also checks the
 * symlink-resolved path, so a link inside the root cannot lead out of it.
 */
export async function resolveBrowsePath(
  browseRoot: string,
  relativePath: string,
  unrestricted = false,
): Promise<string> {
  const normalizedRoot = resolve(browseRoot);
  // On Unix, if relativePath is already an absolute path under browseRoot, use it directly.
  // Only strip the leading separator for bare names like "/projectA" sent by the mobile browse
  // tree — not for full paths like "/Users/foo/bar" which are absolute, not drive-root-relative.
  // On Windows we always strip because "\foo" means "drive root relative", never a full path.
  let sanitized: string;
  if (relativePath === "~" || /^~[/\\]/.test(relativePath)) {
    sanitized = join(homedir(), relativePath.slice(1));
  } else if (
    process.platform !== "win32" &&
    relativePath.startsWith("/") &&
    relativePath.length > 1 &&
    relativePath.includes("/", 1)
  ) {
    sanitized = relativePath;
  } else {
    sanitized = relativePath.replace(/^[/\\]+/, "");
  }
  const target = sanitized ? resolve(normalizedRoot, sanitized) : normalizedRoot;
  // Build the allowed prefix with exactly one separator — normalizedRoot may already end with sep
  // when browseRoot is a drive root (e.g. "C:\"), which would otherwise create a double-sep prefix.
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (!unrestricted && !target.startsWith(rootPrefix) && target !== normalizedRoot) {
    throw new Error("Path outside browse root");
  }
  // Verify the path exists; surface a not-found as a typed error so the handler
  // can answer 404 (folder gone) rather than the out-of-root 400 above.
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new BrowsePathNotFoundError(`Path not found: ${target}`);
    }
    throw err;
  }
  if (!unrestricted) {
    const realRoot = await realpath(normalizedRoot).catch(() => normalizedRoot);
    const realPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
    if (!realTarget.startsWith(realPrefix) && realTarget !== realRoot) {
      throw new Error("Path outside browse root");
    }
  }
  return target;
}

export async function listDirectories(absolutePath: string): Promise<Array<{ name: string }>> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listFiles(absolutePath: string): Promise<Array<{ name: string }>> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createDirectory(parentAbsolutePath: string, name: string): Promise<string> {
  if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
    throw new Error("Invalid directory name");
  }
  const target = join(parentAbsolutePath, name);
  try {
    const s = await stat(target);
    if (s.isDirectory()) throw new Error("Directory already exists");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  await mkdir(target);
  return target;
}

/**
 * Resolve a session's extra directories against the browse root.
 *
 * Every entry must sit inside `browseRoot` and be an existing directory, so
 * the browse-root boundary the system prompt states stays true. An entry that
 * repeats the primary, repeats another entry, or sits inside either is dropped
 * rather than rejected: the agent already has it.
 */
export async function resolveAdditionalPaths(
  browseRoot: string,
  primaryPath: string,
  relativePaths: readonly string[],
  unrestricted = false,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const p of relativePaths) {
    const target = canonicalizeProjectPath(await resolveBrowsePath(browseRoot, p, unrestricted));
    const s = await stat(target);
    if (!s.isDirectory()) throw new Error(`Not a directory: ${target}`);
    resolved.push(target);
  }
  return dropCoveredPaths(canonicalizeProjectPath(primaryPath), resolved);
}

function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

/**
 * Drop entries already covered by the primary or by another entry, keeping
 * the caller's order. Shorter paths are considered first so a parent listed
 * after its child still wins.
 */
export function dropCoveredPaths(primaryPath: string, paths: readonly string[]): string[] {
  const kept = new Set<string>();
  const byLength = [...new Set(paths)].sort((a, b) => a.length - b.length);
  for (const p of byLength) {
    if (isSameOrInside(p, primaryPath)) continue;
    if ([...kept].some((k) => isSameOrInside(p, k))) continue;
    kept.add(p);
  }
  return paths.filter((p, i) => kept.has(p) && paths.indexOf(p) === i);
}
