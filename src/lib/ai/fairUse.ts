import type { AiKind } from "./server-core";

/**
 * The server side of fair use. Before a request goes to the model, the AI server asks the
 * database (ai_begin), with the caller's own sign-in, whether this person may ask now; the
 * database applies the workspace's limits and counts the request. After the answer it closes the
 * request with the tokens the model used (ai_finish). The server holds no key of its own for the
 * database: the caller's token is enough, and the caller can only ever spend their own allowance.
 */

export interface Ticket {
  usage: number;
  key: string;
  remaining: { hour: number; day: number; tokens: number };
}

type Service = { url: string; key: string };

const rpc = (service: Service, token: string, name: string, args: Record<string, unknown>, fetchImpl: typeof fetch) =>
  fetchImpl(`${service.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: service.key, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isWorkspaceId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Asks whether the person may make this request now, and counts it when they may. */
export async function beginUse(
  service: Service,
  token: string,
  workspaceId: string,
  kind: AiKind,
  globalDay: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; ticket: Ticket } | { ok: false; status: number; body: Record<string, unknown> }> {
  const unavailable = { ok: false as const, status: 503, body: { error: "limits_unavailable", message: "The AI limits could not be checked just now. Try again in a moment." } };
  let answer: Record<string, unknown> | null;
  try {
    const response = await rpc(service, token, "ai_begin", { p_workspace: workspaceId, p_kind: kind, p_global_day: globalDay }, fetchImpl);
    if (!response.ok) return unavailable;
    answer = (await response.json()) as Record<string, unknown> | null;
  } catch {
    return unavailable;
  }
  if (!answer || typeof answer !== "object") return unavailable;
  if (answer.allowed !== true) {
    const reason = String(answer.reason ?? "refused");
    return {
      ok: false,
      status: reason === "not_member" ? 403 : 429,
      body: { error: "quota", reason, message: String(answer.message ?? "AI is not available to you right now."), ...(typeof answer.retryAt === "string" ? { retryAt: answer.retryAt } : {}) },
    };
  }
  const remaining = (answer.remaining ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
  return { ok: true, ticket: { usage: Number(answer.usage), key: String(answer.key), remaining: { hour: n(remaining.hour), day: n(remaining.day), tokens: n(remaining.tokens) } } };
}

/** Closes a counted request with the tokens used. A request the model failed does not count. */
export async function finishUse(service: Service, token: string, ticket: Ticket, tokens: number, ok: boolean, fetchImpl: typeof fetch): Promise<void> {
  try {
    await rpc(service, token, "ai_finish", { p_usage: ticket.usage, p_key: ticket.key, p_tokens: Math.max(0, Math.round(tokens)), p_ok: ok }, fetchImpl);
  } catch {
    // The request stays counted as started, which is the safe side.
  }
}
