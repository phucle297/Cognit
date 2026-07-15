/**
 * apps/dashboard/src/components/ConfigView.tsx — config surface.
 *
 * No fake cognit.yaml preview. Live config endpoint is not shipped
 * yet; show an honest empty state instead of inventing values.
 */
import type { JSX } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";

export const ConfigView = (): JSX.Element => (
  <Card data-testid="config-view">
    <CardHeader>
      <CardTitle>Config (cognit.yaml)</CardTitle>
      <CardDescription>
        Live config is not exposed over the HTTP API yet. Edit{" "}
        <code className="text-xs">.cognit/cognit.yaml</code> on disk, or use{" "}
        <code className="text-xs">cognit config</code> in the CLI.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">No remote config payload.</p>
    </CardContent>
  </Card>
);
