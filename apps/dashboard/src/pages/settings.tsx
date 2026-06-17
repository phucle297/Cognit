// 6.6 placeholder (read-only).
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import type { JSX } from "react";

export const SettingsPage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Settings</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        Read-only config + storage usage lands in 6.6.
      </p>
    </CardContent>
  </Card>
);
