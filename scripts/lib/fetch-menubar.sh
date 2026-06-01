#!/usr/bin/env bash
# fetch-menubar.sh — download a pre-built menubar artifact from
# RonenMars/threadbase-menubar GitHub Releases that matches a given submodule
# commit SHA. Sourced from scripts/deploy.sh and scripts/deploy-linux.sh.
#
# Exposes:
#   fetch_menubar_asset <submodule_sha> <asset_glob> <out_dir> <log_path>
#     → on success: prints the downloaded artifact path to stdout, returns 0
#     → on miss (no matching release): returns 2, no error logged
#     → on error (network/parse failure): returns 1, error appended to <log_path>
#
#   menubar_print_fetch_error <log_path>
#     → prints a user-facing error message pointing at the issues tab + log
#
# Uses curl + node (no gh / jq dependency). threadbase-menubar is public, so
# the GH API + asset URLs are anonymous-readable.
#
# SHA matching strategy:
#   For each release, derive its commit SHA:
#     - if .target_commitish is a 40-char hex (e.g. latest-main) → use it
#     - else (it's a branch name like "main") → resolve via the tag's git ref
#   Match against the submodule SHA. First match wins.

MENUBAR_REPO="RonenMars/threadbase-menubar"
MENUBAR_ISSUES_URL="https://github.com/$MENUBAR_REPO/issues"

# Resolve the matching release's asset download URL via a single node script.
# Echoes the URL + filename (tab-separated) on success, empty on miss, or
# the literal string "ERROR\t<message>" on parse/network failure.
_menubar_resolve_asset_url() {
  local submodule_sha="$1"
  local asset_glob="$2"

  node - "$MENUBAR_REPO" "$submodule_sha" "$asset_glob" <<'NODE'
const https = require("node:https");
const [repo, sha, glob] = process.argv.slice(2);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "threadbase-streamer-deploy",
      },
      timeout: 15000,
    }, (res) => {
      // Follow one redirect (release asset downloads, not used here, but safe).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        get(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on("error", reject).on("timeout", function () { this.destroy(new Error(`timeout ${url}`)); });
  });
}

function globToRe(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}

async function releaseSha(rel) {
  const target = rel.target_commitish || "";
  if (/^[0-9a-f]{40}$/.test(target)) return target;
  if (!rel.tag_name) return "";

  // Resolve the tag ref → object SHA.
  let ref;
  try {
    ref = await get(`https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(rel.tag_name)}`);
  } catch { return ""; }
  if (!ref.object) return "";

  // Annotated tag → peel one layer.
  if (ref.object.type === "tag") {
    try {
      const peeled = await get(`https://api.github.com/repos/${repo}/git/tags/${ref.object.sha}`);
      return peeled.object && peeled.object.sha ? peeled.object.sha : "";
    } catch { return ""; }
  }
  return ref.object.sha || "";
}

(async () => {
  let releases;
  try {
    releases = await get(`https://api.github.com/repos/${repo}/releases?per_page=30`);
  } catch (e) {
    process.stdout.write(`ERROR\t${e.message}`);
    return;
  }
  if (!Array.isArray(releases)) {
    process.stdout.write(`ERROR\tunexpected releases response shape`);
    return;
  }

  const re = globToRe(glob);

  for (const rel of releases) {
    const relSha = await releaseSha(rel);
    if (relSha !== sha) continue;

    const asset = (rel.assets || []).find((a) => re.test(a.name));
    if (!asset) {
      // Release matched SHA but no asset for this OS. Treat as miss —
      // the next rolling build will pick up the missing artifact.
      process.stdout.write(`MISS\trelease ${rel.tag_name} matched SHA but has no asset matching ${glob}`);
      return;
    }
    process.stdout.write(`${asset.browser_download_url}\t${asset.name}`);
    return;
  }

  // Miss — emit nothing.
})().catch((e) => {
  process.stdout.write(`ERROR\t${e.message || e}`);
});
NODE
}

# Main entry.
fetch_menubar_asset() {
  local submodule_sha="$1"
  local asset_glob="$2"
  local out_dir="$3"
  local log_path="$4"

  if ! command -v curl >/dev/null 2>&1; then
    echo "[fetch-menubar] curl not found in PATH" >> "$log_path"
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[fetch-menubar] node not found in PATH" >> "$log_path"
    return 1
  fi

  mkdir -p "$out_dir"

  local result
  result="$(_menubar_resolve_asset_url "$submodule_sha" "$asset_glob")"

  if [[ -z "$result" ]]; then
    # Legitimate miss — no matching release.
    return 2
  fi

  if [[ "$result" == MISS$'\t'* ]]; then
    # Matched SHA but no asset for this OS — treat as miss.
    echo "[fetch-menubar] ${result#MISS$'\t'}" >> "$log_path"
    return 2
  fi

  if [[ "$result" == ERROR$'\t'* ]]; then
    echo "[fetch-menubar] resolve failed: ${result#ERROR$'\t'}" >> "$log_path"
    return 1
  fi

  local url="${result%%$'\t'*}"
  local name="${result#*$'\t'}"
  local target="$out_dir/$name"

  if ! curl -sSL --max-time 300 --fail \
       -H 'User-Agent: threadbase-streamer-deploy' \
       -o "$target" "$url" 2>>"$log_path"; then
    echo "[fetch-menubar] download failed: $url" >> "$log_path"
    rm -f "$target"
    return 1
  fi

  printf '%s' "$target"
}

menubar_print_fetch_error() {
  local log_path="$1"
  printf '! menubar release fetch failed\n' >&2
  printf '!   error log: %s\n' "$log_path" >&2
  printf '!   please report at: %s\n' "$MENUBAR_ISSUES_URL" >&2
  printf '!   (please attach the error log)\n' >&2
}
