import { draftProcessFromText, reviveProcessDraft, type ProcessDraft } from "../bpm/draft";
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
    public code: "not_configured" | "access_code" | "quota" | "failed",
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

/** In hosted mode the server applies the open workspace's AI limits, so each request says which workspace it is for. */
let workspaceProvider: (() => string | null) | null = null;
export function setAiWorkspaceProvider(provider: (() => string | null) | null): void {
  workspaceProvider = provider;
}

/** What is left of the person's AI allowance after the last request, when the server said. */
export interface AiAllowance {
  hour: number;
  day: number;
  tokens: number;
}
let lastAllowance: AiAllowance | null = null;
const allowanceListeners = new Set<(a: AiAllowance | null) => void>();
export const currentAllowance = () => lastAllowance;
export function onAllowance(listener: (a: AiAllowance | null) => void): () => void {
  allowanceListeners.add(listener);
  return () => allowanceListeners.delete(listener);
}
function noteAllowance(data: Record<string, unknown> | null) {
  const a = data?.allowance as (Partial<AiAllowance> & { unlimited?: boolean }) | undefined;
  if (!a) return;
  if (a.unlimited === true) {
    // An owner the limits do not stop: nothing to count down, but the use shown is read again.
    lastAllowance = null;
    for (const listener of allowanceListeners) listener(null);
    return;
  }
  if (typeof a.day !== "number") return;
  lastAllowance = { hour: Number(a.hour) || 0, day: a.day, tokens: Number(a.tokens) || 0 };
  for (const listener of allowanceListeners) listener(lastAllowance);
}

/** "Try again after 14:20" for a time today, or with the day for a later one. */
function retryText(at: unknown): string {
  if (typeof at !== "string") return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return ` Try again after ${sameDay ? time : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`}.`;
}

/** A request the workspace's fair-use limits refused. */
const limited = (r: { status: number; data: Record<string, unknown> | null }) =>
  (r.status === 429 || r.status === 403) && r.data?.error === "quota"
    ? new AiError("quota", `${String(r.data.message ?? "AI is not available to you right now.")}${retryText(r.data.retryAt)}`)
    : null;

/** The signed-in person's token, for other endpoints of this server that ask who is calling. */
export const authToken = async (): Promise<string | null> => (tokenProvider ? tokenProvider().catch(() => null) : null);

export interface AiStatus {
  configured: boolean;
  engine: string | null;
  /** The model that reads pictures, when it is not the main one. */
  visionEngine?: string | null;
  /** The server asks for a shared access code before it drafts. */
  needsCode: boolean;
}

async function post(body: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const code = getAccessCode();
    const token = tokenProvider ? await tokenProvider().catch(() => null) : null;
    const workspaceId = workspaceProvider?.() ?? null;
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(workspaceId ? { ...(body as object), workspaceId } : body),
      signal: controller.signal,
    });
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    noteAllowance(data);
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
  const refused = denied(result) ?? limited(result);
  if (refused) throw refused;
  const ok = result.status === 200 ? fromServer(result.data) : null;
  if (ok) return ok;
  throw new AiError("failed", String(result.data?.message ?? "The AI draft failed. Try again."));
}

/** A business process from a description: the AI model when there is one, the built-in rules otherwise. */
export async function draftProcess(text: string): Promise<{ draft: ProcessDraft; engine: string; usedRules: boolean }> {
  const rules = () => ({ draft: draftProcessFromText(text), engine: RULES_ENGINE, usedRules: true });
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "process", text });
  } catch {
    return rules();
  }
  if (result.status === 501 || result.status === 404 || result.status === 405 || (result.status === 200 && !result.data?.process) || hostFailure(result)) return rules();
  const refused = denied(result) ?? limited(result);
  if (refused) throw refused;
  const draft = result.status === 200 ? reviveProcessDraft(result.data?.process) : null;
  if (draft) return { draft, engine: typeof result.data?.engine === "string" ? result.data.engine : "AI model", usedRules: false };
  throw new AiError("failed", String(result.data?.message ?? "The AI draft failed. Try again."));
}

export interface ImageData {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

/** A picture to send: PNG, JPEG, WebP or GIF, up to 5 MB. */
export async function imageFromFile(file: Blob & { type: string }): Promise<ImageData> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw new AiError("failed", "Choose a PNG, JPEG, WebP or GIF image.");
  if (file.size > 5 * 1024 * 1024) throw new AiError("failed", "The image is larger than 5 MB. Use a smaller one and try again.");
  return { mime: file.type as ImageData["mime"], data: await fileToBase64(file as File) };
}

/** A business process read from a picture by the AI model: a diagram, a flowchart, a whiteboard, a page. */
export async function draftProcessFromImage(image: ImageData, note: string): Promise<{ draft: ProcessDraft; engine: string }> {
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "process", text: note.slice(0, 12000), image });
  } catch {
    throw new AiError("failed", "The server could not be reached. Check your connection and try again.");
  }
  if (result.status === 501 || result.status === 404 || result.status === 405 || (result.status === 200 && !result.data?.process)) {
    throw new AiError("not_configured", "Reading a picture needs an AI model, and none is set up. An owner connects one in Settings → Integrations, or describe the process in words.");
  }
  const refused = denied(result) ?? limited(result);
  if (refused) throw refused;
  const draft = result.status === 200 ? reviveProcessDraft(result.data?.process) : null;
  if (draft) return { draft, engine: typeof result.data?.engine === "string" ? result.data.engine : "AI model" };
  throw new AiError("failed", String(result.data?.message ?? "The picture could not be read as a process. Try a clearer picture, or describe it in words."));
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
  const refused = denied(result) ?? limited(result);
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
  const refused = denied(result) ?? limited(result);
  if (refused) throw refused;
  if (result.status === 200 && typeof result.data?.answer === "string" && result.data.answer.trim()) {
    return { answer: result.data.answer, engine: typeof result.data.engine === "string" ? result.data.engine : "AI model" };
  }
  throw new AiError("failed", String(result.data?.message ?? "The AI model did not answer. Try again."));
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Asks the assistant the next turn of a conversation; what the workspace holds goes along as text. */
export async function chatAi(messages: ChatMessage[], context: string, page: string, edit?: { diagramId: string }): Promise<{ answer: string; engine: string }> {
  let result: Awaited<ReturnType<typeof post>>;
  try {
    result = await post({ mode: "chat", messages, context, page, ...(edit ? { edit } : {}) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new AiError("failed", "The AI model took too long to answer. Try again, or ask a narrower question.");
    throw new AiError("failed", "The server could not be reached. Check your connection and try again.");
  }
  if (notConfigured(result)) throw new AiError("not_configured", typeof result.data?.message === "string" ? result.data.message : "No AI model is configured on this server.");
  const refused = denied(result) ?? limited(result);
  if (refused) throw refused;
  if (result.status === 200 && typeof result.data?.answer === "string" && result.data.answer.trim()) {
    return { answer: result.data.answer, engine: typeof result.data.engine === "string" ? result.data.engine : "AI model" };
  }
  throw new AiError("failed", String(result.data?.message ?? "The AI model did not answer. Try again."));
}

type OwnAi = { provider: string; model: string; visionModel: string };
let integrationLookup: (() => Promise<OwnAi | null>) | null = null;
/** How the app learns that the open workspace has its own AI provider (Settings → Integrations). */
export function setAiIntegrationLookup(lookup: (() => Promise<OwnAi | null>) | null): void {
  integrationLookup = lookup;
}

export async function fetchAiStatus(): Promise<AiStatus> {
  const none: AiStatus = { configured: false, engine: null, needsCode: false };
  let server = none;
  try {
    const response = await fetch(ENDPOINT);
    if (response.ok) {
      const data = (await response.json()) as Partial<AiStatus>;
      server = { configured: !!data.configured, engine: data.engine ?? null, visionEngine: typeof data.visionEngine === "string" ? data.visionEngine : null, needsCode: !!data.needsCode };
    }
  } catch {
    server = none;
  }
  // The workspace's own provider is used before the server's key.
  const own = integrationLookup ? await integrationLookup().catch(() => null) : null;
  if (own) return { configured: true, engine: `${own.provider}: ${own.model}`, visionEngine: own.visionModel ? `${own.provider}: ${own.visionModel}` : null, needsCode: server.needsCode };
  return server;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AiError("failed", "The file could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
