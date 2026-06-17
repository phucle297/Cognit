/**
 * apps/dashboard/src/pages/overview.tsx — placeholder.
 * FSD layer: pages. Full UI lands in 6.2.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const OverviewPage = (): JSX.Element => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Projects, sessions, and activity summary land in 6.2.
        </p>
      </CardContent>
    </Card>
  );
};
