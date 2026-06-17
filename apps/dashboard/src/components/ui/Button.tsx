/**
 * AC-required path: src/components/ui/Button.tsx
 *
 * Re-exports the FSD canonical Button (src/shared/ui/button.tsx).
 * Feature-Sliced Design: shared/ui/ owns the source. The
 * src/components/ui/ path is preserved because the Phase 6
 * acceptance criteria and the regression tests in 6.7 import
 * from there. The shim is one line so the import surface
 * remains stable.
 */
export { Button, buttonVariants, type ButtonProps } from "@/shared/ui/button";
