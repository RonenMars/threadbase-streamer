export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  tagName: string;
  prerelease: boolean;
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  published_at: string | null;
  assets: GitHubReleaseAsset[];
}

const GITHUB_API = "https://api.github.com";

function stripV(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function toReleaseInfo(r: GitHubRelease): ReleaseInfo {
  return {
    version: stripV(r.tag_name),
    tagName: r.tag_name,
    prerelease: r.prerelease,
    htmlUrl: r.html_url,
    publishedAt: r.published_at,
    assets: (r.assets ?? []).map((a) => ({
      name: a.name,
      browserDownloadUrl: a.browser_download_url,
      size: a.size,
    })),
  };
}

async function ghFetch(path: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} returned ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetches the newest release on the given channel. "stable" excludes
 * prereleases and drafts; "next" returns the newest prerelease (also
 * excluding drafts). Returns null if no release matches the channel.
 */
export async function fetchLatestRelease(
  repo: string,
  channel: "stable" | "next",
): Promise<ReleaseInfo | null> {
  if (channel === "stable") {
    try {
      const data = (await ghFetch(`/repos/${repo}/releases/latest`)) as GitHubRelease;
      return toReleaseInfo(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("404")) return null;
      throw err;
    }
  }

  const all = (await ghFetch(`/repos/${repo}/releases?per_page=30`)) as GitHubRelease[];
  const prereleases = all.filter((r) => r.prerelease && !r.draft);
  if (prereleases.length === 0) return null;
  return toReleaseInfo(prereleases[0]);
}

export async function fetchReleaseByTag(repo: string, tag: string): Promise<ReleaseInfo | null> {
  const tagToTry = tag.startsWith("v") ? tag : `v${tag}`;
  try {
    const data = (await ghFetch(`/repos/${repo}/releases/tags/${tagToTry}`)) as GitHubRelease;
    return toReleaseInfo(data);
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      try {
        const data = (await ghFetch(`/repos/${repo}/releases/tags/${tag}`)) as GitHubRelease;
        return toReleaseInfo(data);
      } catch {
        return null;
      }
    }
    throw err;
  }
}
