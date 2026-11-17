/**
 * Whether a request comes from someone signed in to the app's accounts service. Kept apart
 * from the AI handler so other endpoints of this server can ask the same question without
 * carrying the AI code with them.
 */

export interface AccountsEnv {
  AI_REQUIRE_SIGN_IN?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

/** The accounts service to check sign-ins against, or null when the app runs without accounts. */
export function accounts(env: AccountsEnv): { url: string; key: string } | null {
  if ((env.AI_REQUIRE_SIGN_IN ?? "").toLowerCase() === "false") return null;
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || "").trim();
  return url && key ? { url, key } : null;
}

/** The caller's sign-in token, from the Authorization header. */
export function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/** Asks the accounts service whether the token belongs to a signed-in person. */
export async function signedIn(request: Request, service: { url: string; key: string }, fetchImpl: typeof fetch): Promise<boolean> {
  const token = bearer(request);
  if (!token || token.length > 4096) return false;
  try {
    const response = await fetchImpl(`${service.url}/auth/v1/user`, { headers: { apikey: service.key, authorization: `Bearer ${token}` } });
    if (!response.ok) return false;
    const user = (await response.json()) as { id?: unknown };
    return typeof user.id === "string" && user.id.length > 0;
  } catch {
    return false;
  }
}
