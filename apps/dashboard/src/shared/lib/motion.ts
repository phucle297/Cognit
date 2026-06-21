/**
 * apps/dashboard/src/shared/lib/motion.ts — motion class builder.
 *
 * Wraps Tailwind's transition utilities with the project's
 * design-token durations + ease. Honors prefers-reduced-motion
 * via the global CSS rule in app/index.css.
 */
import type { CSSProperties } from "react";

export type MotionProperty =
  | "all"
  | "colors"
  | "shadow"
  | "transform"
  | "opacity"
  | "width";

export type MotionDuration = "fast" | "base" | "slow";

const DURATION_VAR: Record<MotionDuration, string> = {
  fast: "var(--duration-fast)",
  base: "var(--duration-base)",
  slow: "var(--duration-slow)",
};

/** Build a Tailwind class string for a transition. */
export const transition = (
  property: MotionProperty = "colors",
  duration: MotionDuration = "base",
): string =>
  `transition-${property} duration-[${DURATION_VAR[duration]}] ease-[var(--ease-out)]`;

/** Page-enter animation (used by main route outlet wrapper). */
export const pageEnter = (): string =>
  "animate-[page-enter_var(--duration-base)_var(--ease-out)_both]";

/** Fade-in animation for tab panels, dialog body, etc. */
export const fadeIn = (): string =>
  "animate-[fade-in_var(--duration-base)_var(--ease-out)_both]";

/**
 * Stagger helper for list items / KPI grids. Pair with
 * `staggerIndex(i)` so each child carries its own animation-delay:
 *
 *   {items.map((it, i) => (
 *     <li className={staggerItem()} style={staggerIndex(i)}>...</li>
 *   ))}
 *
 * The actual keyframes + per-index delay live in app/index.css so
 * the rule stays a single Tailwind-compatible class.
 */
export const staggerItem = (): string => "stagger-item";

/**
 * Inline style binding for the stagger child. Use together with
 * `staggerItem()`.
 */
export const staggerIndex = (index: number): CSSProperties =>
  ({ "--stagger-index": index } as CSSProperties);
