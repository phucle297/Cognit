// 6.5 placeholder.
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const VerificationPage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Verification</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">Rerun / cancel buttons land in 6.5.</p>
    </CardContent>
  </Card>
);
