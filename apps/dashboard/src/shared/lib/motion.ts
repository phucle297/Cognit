/**
 * apps/dashboard/src/shared/lib/motion.ts — motion class builder.
 *
 * Wraps Tailwind's transition utilities with the project's
 * design-token durations + ease. Honors prefers-reduced-motion
 * via the global CSS rule in app/index.css.
 */

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
