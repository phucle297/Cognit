/**
 * apps/dashboard/src/shared/lib/cn.ts — class-name combiner.
 *
 * FSD layer: shared. Used by every UI primitive below.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
