// 6.4 placeholder.
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const KnowledgeGraphPage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Knowledge Graph</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">xyflow + physics/constellation lands in 6.4.</p>
    </CardContent>
  </Card>
);
