/**
 * apps/cli/src/server-http.ts
 *
 * Minimal HTTP client for talking to the local `cognit server` from
 * CLI subcommands. The CLI is a local-only tool — the server binds
 * to loopback by default. There is no auth, no retries, and no
 * shared connection pool; commands that need server data call
 * `serverFetch()` once per invocation.
 *
 * Resolution order for the base URL:
 *   1. `COGNIT_SERVER_URL` env var (full URL, e.g. http://host:port)
 *   2. `--server-url <url>` parsed from the calling command's opts
 *   3. Default: http://127.0.0.1:6971 (the server command's defaults)
 *
 * Phase 7r.3: introduced for `cognit recovery <id>` and `cognit
 * recovery search <q>`. The fetch helper is deliberately tiny so it
 * is easy to swap out (e.g. once the SDK package exposes a
 * typed client).
 */

/** Configuration that callers resolve from CLI flags / env. */
export interface ServerUrlOpts {
  readonly serverUrl?: string | undefined;
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:6971";

/**
 * Resolve the base URL. Reads `COGNIT_SERVER_URL` first so docker
 * compose entrypoints (or tests that spin up an isolated server)
 * can override without touching argv.
 */
export const resolveServerUrl = (opts: ServerUrlOpts = {}): string => {
  const fromEnv = process.env["COGNIT_SERVER_URL"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (opts.serverUrl && opts.serverUrl.trim().length > 0) return opts.serverUrl.trim();
  return DEFAULT_SERVER_URL;
};

/**
 * Thin fetch wrapper. Throws on non-2xx with a `ServerHttpError`
 * carrying the status + body so callers can decide whether to map
 * it to a CLI exit code.
 */
export class ServerHttpError extends Error {
  readonly _tag = "ServerHttpError";
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`server: ${status} ${url} — ${body.slice(0, 200)}`);
  }
}

export interface ServerFetchOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
}

export const serverFetch = async (
  baseUrl: string,
  pathAndQuery: string,
  opts: ServerFetchOptions = {},
): Promise<unknown> => {
  const url = `${baseUrl.replace(/\/+$/, "")}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    (init as { body?: string }).body = opts.body;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new ServerHttpError(res.status, url, text);
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};