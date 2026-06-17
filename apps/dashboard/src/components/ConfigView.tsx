/**
 * apps/dashboard/src/components/ConfigView.tsx — read-only config preview.
 *
 * FSD layer: components. v0.1 baseline: the runtime config
 * endpoint is not yet exposed (lands in v0.2), so we render a
 * hard-coded SAFE-PREVIEW object instead of fetching the live
 * `cognit.yaml`. The masked api_token is the only "live" thing
 * the operator cares about here — everything else is documented
 * as a v0.2 follow-up.
 */
import type { JSX } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";

// TODO v0.2: fetch /admin/config and replace the placeholder below.
const SAFE_PREVIEW = {
  auth: {
    bind: "127.0.0.1:6971",
    api_token: "ck_live_4f2a9b7e",
  },
  actors: {
    defaults: ["planner", "verifier", "decider"],
  },
  redaction: {
    patterns: {
      count: 6,
    },
  },
} as const;

const maskToken = (token: string | undefined): string => {
  if (!token || token.length === 0) return "(not set)";
  const head = token.slice(0, 4);
  return `${head}****`;
};

export const ConfigView = (): JSX.Element => (
  <Card>
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle>Config (cognit.yaml)</CardTitle>
        <span className="text-xs text-muted-foreground">v0.1 preview</span>
      </div>
      <CardDescription>
        Read-only preview of the runtime config. Live fetch of /admin/config lands in v0.2.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">auth</h3>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">bind</dt>
          <dd className="font-mono">{SAFE_PREVIEW.auth.bind}</dd>
          <dt className="text-muted-foreground">api_token</dt>
          <dd className="font-mono" data-testid="api-token">
            {maskToken(SAFE_PREVIEW.auth.api_token)}
          </dd>
        </dl>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">actors.defaults</h3>
        <ul className="list-disc pl-6 text-sm">
          {SAFE_PREVIEW.actors.defaults.map((role) => (
            <li key={role} className="font-mono">{role}</li>
          ))}
        </ul>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">redaction.patterns.count</h3>
        <p className="font-mono text-sm" data-testid="redaction-count">
          {SAFE_PREVIEW.redaction.patterns.count}
        </p>
      </section>
    </CardContent>
  </Card>
);