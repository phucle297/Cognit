/**
 * apps/dashboard/src/widgets/settings-advanced/index.tsx — Settings →
 * Advanced disclosure (Phase B.4).
 *
 * Collapsible card inside `/settings`. Reuses the existing pages as
 * Dialog overlays (no destructive imports, no route deletions). Old
 * URLs (`/rules`, `/recovery-center`, `/decision-graph`,
 * `/verification`, `/ai-reasoning`) keep working through the router
 * — this widget is the primary surface, not the only surface.
 *
 * 5 rows (Guardrails / Recovery / Decisions / Checks / AI reasoning),
 * each is a Button row that opens a Dialog hosting the same page
 * component the route used to render. The dialog takes the full
 * content height so the inner pages render unchanged.
 *
 * FSD layer: widgets. Shares the `Card variant="flat"` pattern used
 * by the rest of /settings.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { ChevronDown, ChevronRight, GitBranch, ListChecks, Network, ShieldAlert, Sparkles, Wrench } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { RulesPage } from "@/pages/rules";
import { RecoveryCenterPage } from "@/pages/recovery-center";
import { DecisionGraphPage } from "@/pages/decision-graph";
import { VerificationPage } from "@/pages/verification";
import { AiReasoningPage } from "@/pages/ai-reasoning";

type SectionId = "guardrails" | "recovery" | "decisions" | "checks" | "ai";

interface SectionDef {
  readonly id: SectionId;
  readonly label: string;
  readonly description: string;
  readonly Icon: typeof ChevronRight;
  /** Old route path the dialog's content used to live at. */
  readonly fromRoute: string;
  /** Dialog body. Each page component already handles its own
   *  empty/loading/error states; we mount it directly inside the
   *  DialogContent so the URLs and behaviour stay identical. */
  readonly Body: () => JSX.Element;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  {
    id: "guardrails",
    label: "Guardrails",
    description: "Constraint rules the engine evaluates on every event append.",
    Icon: ShieldAlert,
    fromRoute: "/rules",
    Body: () => <RulesPage />,
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Session picker + recovery operations (dry-run, snapshot, export).",
    Icon: Wrench,
    fromRoute: "/recovery-center",
    Body: () => <RecoveryCenterPage />,
  },
  {
    id: "decisions",
    label: "Decisions",
    description: "Decision-only reasoning graph (xyflow canvas + state table).",
    Icon: GitBranch,
    fromRoute: "/decision-graph",
    Body: () => <DecisionGraphPage />,
  },
  {
    id: "checks",
    label: "Checks",
    description: "Verification table (id, command, type, status, duration, actions).",
    Icon: ListChecks,
    fromRoute: "/verification",
    Body: () => <VerificationPage />,
  },
  {
    id: "ai",
    label: "AI reasoning",
    description: "AI-supervisor hypothesis ranking + decision log + rank history.",
    Icon: Sparkles,
    fromRoute: "/ai-reasoning",
    Body: () => <AiReasoningPage />,
  },
];

export interface SettingsAdvancedProps {
  /**
   * Optional section id to auto-open. Read from `?advanced=…` on
   * /settings (deep-link support from Overview / Timeline row
   * actions) and from the wrapper redirects in the router (the
   * old URLs land here).
   */
  readonly defaultOpen?: SectionId | undefined;
}

export const SettingsAdvanced = ({ defaultOpen }: SettingsAdvancedProps): JSX.Element => {
  const [open, setOpen] = useState<boolean>(false);
  const [active, setActive] = useState<SectionId | null>(defaultOpen ?? null);

  // When the parent (settings page) hands us a new `defaultOpen`
  // value via the URL, expand the card and open the matching
  // dialog. The ref guards against re-running when the user
  // closes a dialog manually (we only want to react to URL
  // changes, not internal state changes).
  const lastDefaultRef = useRef<SectionId | null>(defaultOpen ?? null);
  useEffect(() => {
    if (defaultOpen === undefined) return;
    if (lastDefaultRef.current === defaultOpen) return;
    lastDefaultRef.current = defaultOpen;
    setOpen(true);
    setActive(defaultOpen);
  }, [defaultOpen]);

  const activeSection = SECTIONS.find((s) => s.id === active) ?? null;

  return (
    <Card variant="flat" data-testid="settings-advanced">
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="settings-advanced-body"
          onClick={(): void => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
          data-testid="settings-advanced-toggle"
        >
          <div>
            <CardTitle className="flex items-center gap-2">
              <Network className="size-4 text-muted-foreground" aria-hidden /> Advanced
            </CardTitle>
            <CardDescription>
              Power-user surfaces — guardrails, recovery, decisions, checks, AI reasoning.
            </CardDescription>
          </div>
          <ChevronDown
            className={
              open
                ? "size-4 shrink-0 rotate-0 text-muted-foreground transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]"
                : "size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform duration-[var(--duration-slow)] ease-[var(--ease-out)]"
            }
            aria-hidden
          />
        </button>
      </CardHeader>
      {open ? (
        <CardContent id="settings-advanced-body" className="flex flex-col gap-2 pt-0">
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2"
              data-testid={`settings-advanced-row-${s.id}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <s.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{s.description}</div>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground" title={`Was ${s.fromRoute}`}>
                  {s.fromRoute}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(): void => {
                    setActive(s.id);
                  }}
                  data-testid={`settings-advanced-open-${s.id}`}
                >
                  Open
                  <ChevronRight className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      ) : null}

      <Dialog
        open={activeSection !== null}
        onOpenChange={(v: boolean): void => {
          if (!v) setActive(null);
        }}
      >
        <DialogContent
          className="max-w-3xl sm:max-w-3xl"
          data-testid={activeSection ? `settings-advanced-dialog-${activeSection.id}` : undefined}
        >
          {activeSection ? (
            <>
              <DialogHeader>
                <DialogTitle>{activeSection.label}</DialogTitle>
                <DialogDescription>
                  Originally at <span className="font-mono">{activeSection.fromRoute}</span>. Same
                  content; opened as an overlay inside Settings.
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[70vh] overflow-y-auto rounded-md border bg-background p-3">
                <activeSection.Body />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export type { SectionId };
