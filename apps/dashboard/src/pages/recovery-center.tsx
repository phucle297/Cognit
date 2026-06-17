// 6.6 placeholder.
import { Badge } from "@/shared/ui/badge";
import type { JSX } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";

export const RecoveryCenterPage = (): JSX.Element => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between space-y-0">
      <CardTitle>Recovery Center</CardTitle>
      <Badge variant="secondary">v0.2</Badge>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        Full recovery output, fuzzy search, and suggested next steps land in v0.2.
      </p>
    </CardContent>
  </Card>
);
