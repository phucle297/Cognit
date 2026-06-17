/**
 * apps/dashboard/src/shared/api/use-api.ts — server-state hook.
 *
 * FSD layer: shared. Thin wrapper around apiFetch with
 * loading/error/data state. v0.1 keeps state local — no React
 * Query, no global store (per STACK.md).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "./api-client";

export type UseApiState<T> = {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  refetch: () => void;
};

export type UseApiOpts = {
  skip?: boolean;
};

export const useApi = <T>(path: string | null, opts: UseApiOpts = {}): UseApiState<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(path !== null && !opts.skip);
  const [tick, setTick] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (path === null || opts.skip) {
      setLoading(false);
      return;
    }
    setLoading(true);
    apiFetch<T>(path)
      .then((value) => {
        if (cancelled.current) return;
        setData(value);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled.current) return;
        if (err instanceof ApiError) {
          setError(err);
        } else {
          setError(
            new ApiError({
              kind: "api_error",
              code: "internal",
              message: err instanceof Error ? err.message : "unknown error",
              request_id: "01hookinternalxxxxxxxx",
            }),
          );
        }
      })
      .finally(() => {
        if (cancelled.current) return;
        setLoading(false);
      });
    return () => {
      cancelled.current = true;
    };
  }, [path, opts.skip, tick]);

  const refetch = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return { data, error, loading, refetch };
};
