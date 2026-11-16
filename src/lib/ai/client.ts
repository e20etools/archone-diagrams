import { draftFromText, RULES_ENGINE } from "./heuristic";
import type { Draft } from "./schema";
import { normalizeDraft } from "./schema";

/** Browser side of AI drafting: asks /api/ai, and falls back to the built-in rules for text when no AI is configured. */

export interface DraftResult {
  draft: Draft;
  engine: string;
  /** True when the built-in rules produced the draft because no AI provider answered. */
  usedRules: boolean;
}

export class AiError extends Error {
  constructor(
    public code: "not_configured" | "access_code" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 90_000;

/** Same-origin /api/ai by default. A host that serves the function elsewhere (a Supabase or Lovable Edge Function) sets VITE_AI_ENDPOINT. */
const ENDPOINT: string = (import.meta.env?.VITE_AI_ENDPOINT as string | undefined)?.trim() || "/api/ai";

const CODE_KEY = "archone.aiAccessCode";
export function getAccessCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setAccessCode(code: string): void {
  try {
    if (code.trim()) localStorage.setItem(CODE_KEY, code.trim());
    else localStorage.removeItem(CODE_KEY);
  } catch {
    // Storage is blocked; the code simply is not remembered.
  }
}

/** In hosted mode the server only drafts for signed-in people; the session supplies their token. */
let tokenProvider: (() => Promise<string | null>) | null = null;
export function setAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  tokenProvider = provider;
}

export interface AiStatus {
  configured: boolean;
  engine: string | null;
  /** The server asks for a shared access code before it drafts. */
  needsCode: boolean;
}

async function post(body: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const code = getAccessCode();
    const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** A host without the function answers 404 or serves the page itself; both mean "no AI here". */
const notConfigured = (r: { status: number; data: Record<string, unknown> | null }) =>
  r.status === 501 || r.status === 404 || r.status === 405 || (r.status === 200 && !r.data?.draft && !r.data?.answer);

/** The host's own error page (a function that crashed or timed out), as opposed to an answer from our endpoint. */
const hostFailure = (r: { status: number; data: Record<string, unknown> | null }) => r.status >= 500 && typeof r.data?.error !== "string";

const CODE_MESSAGE = "This server asks for an AI access code. Enter the code in Settings, then try again.";
const SIGN_IN_MESSAGE = "Your sign-in has expired. Sign in again, then try once more.";
const denied = (r: { status: number; data: Record<string, unknown> | null }) =>
  r.status === 401 ? new AiError("access_code", r.data?.error === "sign_in_required" ? SIGN_IN_MESSAGE : CODE_MESSAGE) : null;

function fromServer(data: Record<string, unknown> | null): DraftResult | null {
  const draft = normalizeDraft(data?.draft);
  if (!draft) return null;
  return { draft, engine: typeof data?.engine === "string" ? data.engine : "AI model", usedRules: false };
}

export async function draftFromPrompt(text: string): Promise<DraftResult> {
  const rules = (): DraftResult => ({ draft: draftFromText(text), engine: RULES_ENGINE, usedRules: true });
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "prompt", text });
  } catch {
    return rules(); // offline or no server: the built-in rules still work
  }
  if (notConfigured(result) || hostFailure(result)) return rules();
  const refused = denied(result);
  if (refused) throw refused;
  const ok = result.status === 200 ? fromServer(result.data) : null;
  if (ok) return ok;
  throw new AiError("failed", String(result.data?.message ?? "The AI draft failed. Try again."));
}

export async function draftFromImage(file: File, note: string): Promise<DraftResult> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new AiError("failed", "Choose a PNG, JPEG, WebP or GIF image.");
  }
  if (file.size > 5 * 1024 * 1024) throw new AiError("failed", "The image is larger than 5 MB. Export a smaller one and try again.");
  const data = await fileToBase64(file);
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "image", text: note, image: { mime: file.type, data } });
  } catch {
    throw new AiError("failed", "The server could not be reached. Check your connection and try again.");
  }
  if (notConfigured(result)) {
    throw new AiError(
      "not_configured",
      "Reading an image needs an AI model, and none is configured on this server yet. Add an AI key in the hosting settings, or describe the diagram in text instead.",
    );
  }
  const refused = denied(result);
  if (refused) throw refused;
  const ok = result.status === 200 ? fromServer(result.data) : null;
  if (ok) return ok;
  throw new AiError("failed", String(result.data?.message ?? "The image could not be read. Try again."));
}

/** Asks the configured AI model a question about the model, which is sent along as text. */
export async function askAi(question: string, context: string): Promise<{ answer: string; engine: string }> {
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "ask", question, context });
  } catch {
    throw new AiError("failed", "The server could not be reached. Check your connection and try again.");
  }
  if (notConfigured(result)) throw new AiError("not_configured", "No AI model is configured on this server.");
  const refused = denied(result);
  if (refused) throw refused;
  if (result.status === 200 && typeof result.data?.answer === "string" && result.data.answer.trim()) {
    return { answer: result.data.answer, engine: typeof result.data.engine === "string" ? result.data.engine : "AI model" };
  }
  throw new AiError("failed", String(result.data?.message ?? "The AI model did not answer. Try again."));
}

export async function fetchAiStatus(): Promise<AiStatus> {
  const none: AiStatus = { configured: false, engine: null, needsCode: false };
  try {
    const response = await fetch(ENDPOINT);
    if (!response.ok) return none;
    const data = (await response.json()) as Partial<AiStatus>;
    return { configured: !!data.configured, engine: data.engine ?? null, needsCode: !!data.needsCode };
  } catch {
    return none;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AiError("failed", "The file could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
