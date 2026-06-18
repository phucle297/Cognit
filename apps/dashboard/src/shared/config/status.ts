/**
 * apps/dashboard/src/shared/config/status.ts — status → token map.
 *
 * Single source of truth for status color, label, and icon used
 * by StatusPill + Badge variants + DataTable cells. Server event
 * types and session lifecycle statuses all funnel through here.
 */
import {
  CheckCircle2,
  CircleDashed,
  CircleX,
  Archive,
  Circle,
  type LucideIcon,
} from "lucide-react";

export type StatusKey =
  | "active"
  | "pending"
  | "failed"
  | "verified"
  | "archived"
  | "neutral";

export interface StatusMeta {
  readonly bg: string;
  readonly fg: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

export const STATUS_META: Readonly<Record<StatusKey, StatusMeta>> = {
  active: {
    bg: "bg-[var(--color-status-active-bg)]",
    fg: "text-[var(--color-status-active)]",
    label: "Active",
    icon: CheckCircle2,
  },
  pending: {
    bg: "bg-[var(--color-status-pending-bg)]",
    fg: "text-[var(--color-status-pending)]",
    label: "Pending",
    icon: CircleDashed,
  },
  failed: {
    bg: "bg-[var(--color-status-failed-bg)]",
    fg: "text-[var(--color-status-failed)]",
    label: "Failed",
    icon: CircleX,
  },
  verified: {
    bg: "bg-[var(--color-status-verified-bg)]",
    fg: "text-[var(--color-status-verified)]",
    label: "Verified",
    icon: CheckCircle2,
  },
  archived: {
    bg: "bg-[var(--color-status-archived-bg)]",
    fg: "text-[var(--color-status-archived)]",
    label: "Archived",
    icon: Archive,
  },
  neutral: {
    bg: "bg-muted",
    fg: "text-muted-foreground",
    label: "Unknown",
    icon: Circle,
  },
};

export const statusMeta = (key: StatusKey): StatusMeta => STATUS_META[key];
