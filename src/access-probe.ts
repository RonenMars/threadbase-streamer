// Does an edge gate stand between paired devices and this server?
//
// **Why the streamer asks this at all.** A sealed request carries no
// `Authorization` header — that is the point of the envelope — and an
// interactive Cloudflare Access application rejects credential-less requests at
// the edge, before the tunnel. Measured on hardware (D2 row 9, 2026-09-02): with
// Access in front of a tunnelled streamer, `POST /api/e2ee/open` never arrives;
// the device receives an HTML redirect to a login page where message 2 belongs,
// and pairing fails closed with "this server offered an encrypted pairing and
// then did not finish it". Nothing in that message points at the gate, so the
// operator regenerates pairing codes forever.
//
// The server is the one component that can see both sides: it knows its own
// public URL and can ask the edge what an unauthenticated device would get. So
// it asks once, at boot, and says so plainly.

/** What the probe found. */
export type AccessProbeResult =
  /** No gate: an unauthenticated request reached this server. */
  | { kind: "open"; status: number }
  /** A gate answered instead of this server. `location` is the login redirect. */
  | { kind: "gated"; status: number; location: string; serviceTokenAccepted?: boolean }
  /** The probe could not tell. Never a warning — an unreachable public URL is a
   *  different problem with its own symptoms, and guessing would cry wolf. */
  | { kind: "unknown"; reason: string };

export interface AccessServiceToken {
  clientId: string;
  clientSecret: string;
}

/**
 * A redirect to Cloudflare's Access login is the signature: any 30x whose
 * `location` names the `/cdn-cgi/access/login` path. Matched on the path rather
 * than the hostname because the team domain is per-account
 * (`<team>.cloudflareaccess.com`) and a custom domain is allowed.
 */
function isAccessRedirect(status: number, location: string | null): location is string {
  if (status < 300 || status >= 400 || !location) return false;
  return location.includes("/cdn-cgi/access/login");
}

/**
 * One request to this server's own public URL, from outside its own process.
 *
 * `/healthz` deliberately: it needs no credential, so a non-200 says something
 * about the *path in front of* the server rather than about authorization.
 * `redirect: "manual"` because the answer IS the redirect — following it would
 * fetch a login page and lose the evidence.
 */
export async function probeAccessGate(args: {
  publicUrl: string;
  serviceToken?: AccessServiceToken;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AccessProbeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const base = args.publicUrl.replace(/\/$/, "");
  const timeoutMs = args.timeoutMs ?? 5000;

  const once = async (headers?: Record<string, string>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${base}/healthz`, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        ...(headers ? { headers } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await once();
  } catch (err) {
    // Includes the timeout. An unreachable public URL is not a gate.
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }

  const location = res.headers.get("location");
  if (!isAccessRedirect(res.status, location)) {
    return { kind: "open", status: res.status };
  }

  // A gate is there. If the operator configured a service token, the useful
  // question is no longer "is there a gate" but "does my token get through it",
  // because that is the difference between a working rollout and a broken one.
  if (!args.serviceToken) {
    return { kind: "gated", status: res.status, location };
  }
  try {
    const withToken = await once({
      "CF-Access-Client-Id": args.serviceToken.clientId,
      "CF-Access-Client-Secret": args.serviceToken.clientSecret,
    });
    const tokenLocation = withToken.headers.get("location");
    return {
      kind: "gated",
      status: res.status,
      location,
      serviceTokenAccepted: !isAccessRedirect(withToken.status, tokenLocation),
    };
  } catch {
    // The unauthenticated probe already answered the question that matters.
    // A failed second request leaves `serviceTokenAccepted` absent, which the
    // message below reads as "not verified" rather than as "rejected".
    return { kind: "gated", status: res.status, location };
  }
}

/**
 * The operator-facing sentence. Separate from the probe so a test can read the
 * words rather than assert on a shape, and so the wording can change without
 * touching the network code.
 */
export function describeAccessProbe(result: AccessProbeResult): string | null {
  if (result.kind !== "gated") return null;
  const head =
    "An edge gate (Cloudflare Access) answers requests to this server's public URL, so encrypted " +
    "devices cannot reach it: a sealed request carries no Authorization header by design, and the " +
    "gate refuses it before it arrives. Pairing will fail with a message that blames the server.";
  if (result.serviceTokenAccepted === true) {
    return `${head} The configured Access service token DOES satisfy the gate, so devices presenting it can pair.`;
  }
  if (result.serviceTokenAccepted === false) {
    return `${head} The configured Access service token does NOT satisfy the gate — check that a Service Auth policy names it.`;
  }
  return `${head} Fix it by removing Access from this hostname, or by adding a service token and a Service Auth policy for it.`;
}

/**
 * The host of the login redirect, and nothing else.
 *
 * That URL carries a signed JWT in its query string — identity metadata about
 * the account and the request. The host (`<team>.cloudflareaccess.com`) is the
 * diagnostic an operator needs; the rest is not ours to write into a log file
 * that ends up attached to bug reports.
 */
export function safeHost(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location).host;
  } catch {
    return undefined;
  }
}
