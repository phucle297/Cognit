/**
 * apps/dashboard/src/pages/settings.tsx — Settings (6.6).
 *
 * FSD layer: pages. Read-only v0.1: Config tab + Storage tab.
 * Re-exports, fuzzy search, and the redaction editor land in v0.2.
 */
import type { JSX } from "react";
import { ConfigView } from "@/components/ConfigView";
import { StorageUsage } from "@/components/StorageUsage";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui/tabs";

export const SettingsPage = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Settings</CardTitle>
    </CardHeader>
    <CardContent>
      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
        </TabsList>
        <TabsContent value="config">
          <ConfigView />
        </TabsContent>
        <TabsContent value="storage">
          <StorageUsage />
        </TabsContent>
      </Tabs>
    </CardContent>
  </Card>
);