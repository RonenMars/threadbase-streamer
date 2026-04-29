import { mkdir, readdir, realpath, stat } from "fs/promises";
import { join, resolve, sep } from "path";

export async function resolveBrowsePath(browseRoot: string, relativePath: string): Promise<string> {
  const normalizedRoot = resolve(browseRoot);
  // Strip any leading separators so that "/foo" or "\foo" is treated as relative to browseRoot
  // rather than as a drive-root-relative path on Windows (where path.resolve would return C:\foo).
  const sanitized = relativePath.replace(/^[/\\]+/, "");
  const target = sanitized ? resolve(normalizedRoot, sanitized) : normalizedRoot;
  // Build the allowed prefix with exactly one separator — normalizedRoot may already end with sep
  // when browseRoot is a drive root (e.g. "C:\"), which would otherwise create a double-sep prefix.
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (!target.startsWith(rootPrefix) && target !== normalizedRoot) {
    throw new Error("Path outside browse root");
  }
  // Verify the path exists (throws if not)
  await realpath(target);
  return target;
}

export async function listDirectories(absolutePath: string): Promise<Array<{ name: string }>> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
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
