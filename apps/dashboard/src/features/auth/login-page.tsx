/**
 * apps/dashboard/src/features/auth/login-page.tsx — login form.
 *
 * FSD layer: features. Owns the user-facing login interaction:
 * controlled input, POST to /auth/login, navigate("/") on 204,
 * surface ApiError otherwise. The page is wrapped in
 * <AppRouterProvider> at the route level.
 */
import { useState, type FormEvent } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/shared/api/api-client";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

export const LoginPage = (): JSX.Element => {
  const navigate = useNavigate();
  const [token, setToken] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch<void>("/auth/login", {
        method: "POST",
        body: { token },
      });
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.api.message);
      } else {
        setError(err instanceof Error ? err.message : "unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Cognit</CardTitle>
          <CardDescription>
            Paste your <code className="font-mono text-xs">COGNIT_API_TOKEN</code>. The server sets a session
            cookie on success.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={onSubmit}>
            <label className="text-sm font-medium" htmlFor="token">
              API token
            </label>
            <Input
              id="token"
              name="token"
              type="password"
              autoFocus
              required
              minLength={8}
              placeholder="API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={submitting || token.length < 8}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
