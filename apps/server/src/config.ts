/**
 * apps/server/src/config.ts — server bind resolution.
 *
 * Local-only tool — no auth. This file resolves the bind host and
 * port the Hono server should listen on. Default bind is `127.0.0.1`
 * (loopback). Docker compose overrides to `0.0.0.0` so the container
 * is reachable inside the user-defined docker network, but no port
 * is ever published to the host — see `docker-compose.yml`.
 */
export type BindAddress = "127.0.0.1" | "0.0.0.0" | "::1" | "localhost";

export interface ServerConfig {
  readonly bind: BindAddress;
}

export const isLoopbackHost = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

/**
 * Resolve the bind host. CLI `--host` wins; fall back to loopback.
 * The bind is informational — no auth gate depends on it (auth is
 * gone in v0.2).
 */
export const resolveServerConfig = (input: {
  readonly cliHost?: string | undefined;
}): ServerConfig => {
  const bind: BindAddress = isLoopbackHost(input.cliHost ?? "")
    ? (input.cliHost as BindAddress)
    : "127.0.0.1";
  return { bind };
};