/**
 * apps/server/src/config.ts — server config resolution.
 *
 * Token precedence (highest first):
 *   1. `COGNIT_API_TOKEN` env var (escapes a leaked yaml).
 *   2. `--api-token` CLI flag passed to `cognit server`.
 *   3. `auth.api_token` field in `.cognit/cognit.yaml`.
 *
 * If the resolved token is empty/whitespace and the bind host is a
 * non-loopback address, the server starts but `shouldEnforceAuth`
 * returns false — the server prints a warning. The intent is: a
 * non-loopback bind without a token is treated as "developer wanted
 * it open for the local case" rather than silently denying every
 * request.
 *
 * `bind` defaults to `127.0.0.1` (forces loopback bypass). It can
 * come from `auth.bind` in yaml or `--host` from the CLI.
 *
 * `cookieName` defaults to `cognit_session`. It is used both as the
 * cookie name set by `POST /auth/login` and as the lookup key the
 * bearer middleware accepts as a fallback for same-origin SSE
 * clients (EventSource cannot set `Authorization`).
 */
export type BindAddress = "127.0.0.1" | "0.0.0.0" | "::1" | "localhost";

export interface AuthConfig {
  readonly apiToken: string | null;
  readonly bind: BindAddress;
  readonly cookieName: string;
}

export interface ServerConfig {
  readonly auth: AuthConfig;
  readonly isLoopback: boolean;
  readonly enforceAuth: boolean;
}

const DEFAULT_COOKIE_NAME = "cognit_session";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host);

const trimOrNull = (s: string | undefined | null): string | null => {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
};

export const resolveAuthConfig = (input: {
  /** Value of `process.env.COGNIT_API_TOKEN` (already-resolved). */
  readonly envToken?: string | undefined;
  /** Value of `--api-token` CLI flag (already-resolved). */
  readonly cliToken?: string | undefined;
  /** Value of `auth.api_token` parsed from yaml (already-resolved). */
  readonly yamlToken?: string | undefined;
  /** Value of `--host` CLI flag. */
  readonly cliHost?: string | undefined;
  /** Value of `auth.bind` parsed from yaml. */
  readonly yamlBind?: BindAddress | undefined;
  /** Value of `auth.cookie_name` parsed from yaml. */
  readonly yamlCookieName?: string | undefined;
}): AuthConfig => {
  const apiToken =
    trimOrNull(input.envToken) ??
    trimOrNull(input.cliToken) ??
    trimOrNull(input.yamlToken) ??
    null;
  const bind: BindAddress =
    input.cliHost !== undefined && isLoopbackHost(input.cliHost)
      ? (input.cliHost as BindAddress)
      : input.yamlBind ?? "127.0.0.1";
  const cookieName = input.yamlCookieName ?? DEFAULT_COOKIE_NAME;
  return { apiToken, bind, cookieName };
};

/**
 * Decide whether bearer auth should be enforced given the resolved
 * config. Mirrors the production wiring in `apps/server/src/index.ts`.
 *
 *   - `bind` is loopback → no auth (OS-isolated).
 *   - `apiToken` is null/empty → no auth.
 *   - otherwise → require bearer (or same-origin cookie).
 */
export const buildServerConfig = (auth: AuthConfig): ServerConfig => {
  const isLoopback = isLoopbackHost(auth.bind);
  const enforceAuth = !isLoopback && auth.apiToken !== null;
  return { auth, isLoopback, enforceAuth };
};