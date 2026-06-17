// 6.3 placeholder.
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const TimelinePage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Timeline</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Live event stream + filters land in 6.3.</p>
    </CardContent>
  </Card>
);
