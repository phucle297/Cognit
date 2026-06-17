/**
 * apps/dashboard/src/lib/node-colors.ts — entity type palette.
 *
 * Deterministic colour per entity type for the Knowledge Graph
 * nodes and edges. Tailwind v4 is token-driven (see
 * src/app/index.css), so we use Tailwind utility classes that
 * reference the design tokens defined there.
 */
export type EntityType =
  | "hypothesis"
  | "decision"
  | "conclusion"
  | "verification"
  | "finding"
  | "observation"
  | "theory"
  | "experiment";

export type EdgeType = string;

const NODE_FILL: Record<EntityType, string> = {
  hypothesis: "bg-blue-500",
  decision: "bg-amber-500",
  conclusion: "bg-emerald-500",
  verification: "bg-violet-500",
  finding: "bg-rose-500",
  observation: "bg-cyan-500",
  theory: "bg-fuchsia-500",
  experiment: "bg-orange-500",
};

const NODE_TEXT: Record<EntityType, string> = {
  hypothesis: "text-blue-50",
  decision: "text-amber-50",
  conclusion: "text-emerald-50",
  verification: "text-violet-50",
  finding: "text-rose-50",
  observation: "text-cyan-50",
  theory: "text-fuchsia-50",
  experiment: "text-orange-50",
};

const NODE_BORDER: Record<EntityType, string> = {
  hypothesis: "border-blue-700",
  decision: "border-amber-700",
  conclusion: "border-emerald-700",
  verification: "border-violet-700",
  finding: "border-rose-700",
  observation: "border-cyan-700",
  theory: "border-fuchsia-700",
  experiment: "border-orange-700",
};

const EDGE_COLOR: Record<string, string> = {
  supports: "#10b981",
  contradicts: "#ef4444",
  depends_on: "#6366f1",
  verified_by: "#8b5cf6",
  informs: "#0ea5e9",
  supersedes: "#f59e0b",
  cites: "#64748b",
};

const FALLBACK_NODE_FILL = "bg-slate-500";
const FALLBACK_NODE_TEXT = "text-slate-50";
const FALLBACK_NODE_BORDER = "border-slate-700";
const FALLBACK_EDGE_COLOR = "#94a3b8";

export const nodeFill = (entityType: string): string =>
  NODE_FILL[entityType as EntityType] ?? FALLBACK_NODE_FILL;

export const nodeText = (entityType: string): string =>
  NODE_TEXT[entityType as EntityType] ?? FALLBACK_NODE_TEXT;

export const nodeBorder = (entityType: string): string =>
  NODE_BORDER[entityType as EntityType] ?? FALLBACK_NODE_BORDER;

export const edgeColor = (edgeType: string): string =>
  EDGE_COLOR[edgeType] ?? FALLBACK_EDGE_COLOR;

export const edgeStroke = (edgeType: string): string =>
  edgeColor(edgeType);
