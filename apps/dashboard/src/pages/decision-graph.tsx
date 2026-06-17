// 6.5 placeholder.
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const DecisionGraphPage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Decision Graph</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Accepted / rejected decisions land in 6.5.</p>
    </CardContent>
  </Card>
);
