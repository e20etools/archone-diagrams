import { z } from "zod";
import { buildAskSystemPrompt, buildAskText, buildChatSystemPrompt, buildSystemPrompt, buildUserText } from "./prompt";
import { normalizeDraft } from "./schema";
import { normalizeProcessDraft, PROCESS_SYSTEM_PROMPT, processImageText, processUserText } from "../bpm/draft";

/**
 * Server-side AI drafting, independent of the host. api/ai.ts wraps it for Vercel and
 * vite.config.ts wraps it for local development. The API key stays on the server:
 * the browser only ever calls /api/ai.
 *
 * Configure one provider with environment variables:
 *   AI_PROVIDER      anthropic | openai | groq | lovable | openai-compatible   (optional, inferred from the key)
 *   AI_API_KEY       the key                              (or ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, LOVABLE_API_KEY)
 *   AI_MODEL         the model id                         (required except for anthropic and groq)
 *   AI_VISION_MODEL  a model for drafting from pictures, when the main one takes no images
 *   AI_BASE_URL      base URL for openai-compatible providers
 *   AI_REASONING_EFFORT  openai only: low | medium | high | xhigh (the model's own default when unset)
 */

export interface AiEnv {
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  AI_VISION_MODEL?: string;
  AI_REASONING_EFFORT?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  LOVABLE_API_KEY?: string;
}

export interface AiResult {
  status: number;
  body: Record<string, unknown>;
  /** Tokens the model reported using, for fair-use accounting. Not sent to the browser. */
  tokens?: number;
}

const MAX_TEXT = 12_000;
const MAX_IMAGE_BASE64 = 7_000_000; // about 5 MB of image
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const MAX_QUESTION = 1000;
export const MAX_CONTEXT = 240_000;
/** A conversation with the assistant: its last turns, each of a bounded length. */
export const MAX_CHAT_TURNS = 16;
export const MAX_CHAT_TEXT = 6000;

const chatTurnSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(MAX_CHAT_TEXT) });

const imageSchema = z.object({ mime: z.enum(IMAGE_TYPES), data: z.string().min(100).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/=]+$/) });

const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("prompt"), text: z.string().trim().min(3).max(MAX_TEXT) }),
  z.object({
    mode: z.literal("image"),
    text: z.string().max(2000).optional(),
    image: imageSchema,
  }),
  // A question about the model. The model travels with the question, as text; the server keeps none of it.
  z.object({ mode: z.literal("ask"), question: z.string().trim().min(3).max(MAX_QUESTION), context: z.string().max(MAX_CONTEXT) }),
  // A business process described in words, or shown in a picture (a diagram, a flowchart, a whiteboard, a page), drafted as BPMN steps and flows.
  z.object({ mode: z.literal("process"), text: z.string().trim().max(MAX_TEXT).default(""), image: imageSchema.optional() }),
  // A conversation with the assistant. What the workspace holds travels with every turn, as text; the server keeps none of it.
  z.object({
    mode: z.literal("chat"),
    messages: z
      .array(chatTurnSchema)
      .min(1)
      .max(MAX_CHAT_TURNS)
      .refine((turns) => turns[turns.length - 1]?.role === "user", "The last turn is the person's."),
    context: z.string().max(MAX_CONTEXT),
    /** Where in the app the person is, in words. */
    page: z.string().max(300).optional(),
    /** The diagram the person is editing and lets the assistant change. */
    edit: z.object({ diagramId: z.string().min(1).max(120) }).optional(),
  }),
]);
export type AiRequest = z.infer<typeof requestSchema>;

/** A request the schema lets through that still says nothing to work from. */
const empty = (r: AiRequest) => r.mode === "process" && !r.image && r.text.length < 3;

/** The picture that goes with a request, if any. */
const imageOf = (r: AiRequest) => (r.mode === "image" || r.mode === "process" ? r.image : undefined);

export interface Provider {
  id: "anthropic" | "openai" | "groq" | "lovable" | "openai-compatible";
  key: string;
  model: string;
  baseUrl: string;
  /** Used for drafting from a picture, when set. */
  visionModel?: string;
  /** A ceiling on the answer's length, for plans that count it against a per-minute allowance. */
  maxTokens?: number;
  /** Sent with each call besides the key: a workspace's own provider is reached through the integrations function. */
  headers?: Record<string, string>;
  /** Where the person fixes a key the provider refuses. */
  keyHint?: string;
  /** OpenAI's thinking models: how long to think before answering. */
  reasoningEffort?: string;
}

/**
 * A workspace's own AI provider (Settings → Integrations), reached through the integrations Edge
 * Function with the person's sign-in and a ticket for a request already counted by ai_begin. The
 * function adds the key it keeps; this server never sees it.
 */
export function workspaceProvider(integration: { provider: string; model: string; visionModel: string }, via: { url: string; anonKey: string; token: string; workspaceId: string; usage: number; ticket: string }): Provider {
  return {
    id: "openai-compatible",
    key: via.token,
    model: integration.model || integration.provider,
    visionModel: integration.visionModel || undefined,
    baseUrl: `${via.url.replace(/\/$/, "")}/functions/v1/integrations/v1`,
    maxTokens: 4096,
    headers: { apikey: via.anonKey, "x-archone-workspace": via.workspaceId, "x-archone-usage": String(via.usage), "x-archone-ticket": via.ticket },
    keyHint: "Check the AI provider's key in Settings → Integrations.",
  };
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
/** Groq's free plan: a capable text model, and one that reads pictures. */
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GROQ_VISION_MODEL = "qwen/qwen3.8-27b";

export function resolveProvider(env: AiEnv): Provider | null {
  const wanted = env.AI_PROVIDER?.trim().toLowerCase();
  const pick = (id: Provider["id"]): Provider | null => {
    switch (id) {
      case "anthropic": {
        const key = env.ANTHROPIC_API_KEY || env.AI_API_KEY;
        return key ? { id, key, model: env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL, baseUrl: env.AI_BASE_URL || "https://api.anthropic.com" } : null;
      }
      case "openai": {
        const key = env.OPENAI_API_KEY || env.AI_API_KEY;
        return key && env.AI_MODEL
          ? {
              id,
              key,
              model: env.AI_MODEL,
              visionModel: env.AI_VISION_MODEL,
              baseUrl: env.AI_BASE_URL || "https://api.openai.com/v1",
              ...(/^(none|minimal|low|medium|high|xhigh|max)$/.test(env.AI_REASONING_EFFORT?.trim() ?? "") ? { reasoningEffort: env.AI_REASONING_EFFORT!.trim() } : {}),
            }
          : null;
      }
      case "groq": {
        const key = env.GROQ_API_KEY || env.AI_API_KEY;
        return key
          ? {
              id,
              key,
              model: env.AI_MODEL || DEFAULT_GROQ_MODEL,
              visionModel: env.AI_VISION_MODEL || DEFAULT_GROQ_VISION_MODEL,
              baseUrl: env.AI_BASE_URL || "https://api.groq.com/openai/v1",
              maxTokens: 4096,
            }
          : null;
      }
      case "lovable": {
        const key = env.LOVABLE_API_KEY || env.AI_API_KEY;
        return key && env.AI_MODEL ? { id, key, model: env.AI_MODEL, baseUrl: env.AI_BASE_URL || "https://ai.gateway.lovable.dev/v1" } : null;
      }
      case "openai-compatible":
        return env.AI_API_KEY && env.AI_MODEL && env.AI_BASE_URL
          ? { id, key: env.AI_API_KEY, model: env.AI_MODEL, visionModel: env.AI_VISION_MODEL, baseUrl: env.AI_BASE_URL }
          : null;
    }
  };
  if (wanted === "anthropic" || wanted === "openai" || wanted === "groq" || wanted === "lovable" || wanted === "openai-compatible") return pick(wanted);
  if (env.ANTHROPIC_API_KEY) return pick("anthropic");
  if (env.OPENAI_API_KEY) return pick("openai");
  if (env.GROQ_API_KEY) return pick("groq");
  if (env.LOVABLE_API_KEY) return pick("lovable");
  if (env.AI_API_KEY && env.AI_BASE_URL) return pick("openai-compatible");
  return null;
}

/** Safe to show in the browser: says whether AI is set up, never the key. */
export function aiStatus(env: AiEnv): { configured: boolean; engine: string | null; visionEngine?: string } {
  const provider = resolveProvider(env);
  if (!provider) return { configured: false, engine: null };
  const status = { configured: true, engine: `${provider.id}:${provider.model}` };
  return provider.visionModel && provider.visionModel !== provider.model
    ? { ...status, visionEngine: `${provider.id}:${provider.visionModel}` }
    : status;
}

/** Pulls the JSON object out of a model answer, with or without a code fence around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A conversation as the providers take it: it opens with the person, and two turns of the same
 * side in a row (a question whose answer failed) become one.
 */
export function chatTurns(messages: { role: "user" | "assistant"; content: string }[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!turns.length && m.role !== "user") continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text = `${last.text}\n\n${m.content}`;
    else turns.push({ role: m.role, text: m.content });
  }
  return turns;
}

/** What is sent to the model: the instruction, and the turns of the conversation (one, except in a chat). */
function messageFor(request: AiRequest): { system: string; turns: Turn[]; maxTokens: number } {
  const one = (text: string): Turn[] => [{ role: "user", text }];
  if (request.mode === "chat") return { system: buildChatSystemPrompt(request.context, request.page ?? "", request.edit?.diagramId), turns: chatTurns(request.messages), maxTokens: request.edit ? 4000 : 2500 };
  if (request.mode === "ask") return { system: buildAskSystemPrompt(), turns: one(buildAskText(request.question, request.context)), maxTokens: 1500 };
  if (request.mode === "process") return { system: PROCESS_SYSTEM_PROMPT, turns: one(request.image ? processImageText(request.text) : processUserText(request.text)), maxTokens: 8000 };
  return { system: buildSystemPrompt(), turns: one(buildUserText(request.mode, request.text ?? "")), maxTokens: 8000 };
}

async function callAnthropic(p: Provider, request: AiRequest, fetchImpl: typeof fetch): Promise<Response> {
  const { system, turns, maxTokens } = messageFor(request);
  const messages = turns.map((turn, i) => {
    const content: unknown[] = [];
    const image = imageOf(request);
    if (image && i === turns.length - 1) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
    }
    content.push({ type: "text", text: turn.text });
    return { role: turn.role, content };
  });
  return fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, system, messages }),
  });
}

async function callOpenAiStyle(p: Provider, request: AiRequest, fetchImpl: typeof fetch): Promise<Response> {
  const { system, turns, maxTokens } = messageFor(request);
  // Plain text for text requests: some OpenAI-style hosts accept a list of parts only for vision models.
  const image = imageOf(request);
  const messages = turns.map((turn, i) => ({
    role: turn.role,
    content:
      image && i === turns.length - 1
        ? [
            { type: "text", text: turn.text },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } },
          ]
        : turn.text,
  }));
  return fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}`, ...p.headers },
    body: JSON.stringify({
      model: modelFor(p, request),
      messages: [{ role: "system", content: system }, ...messages],
      ...(p.maxTokens ? { max_tokens: Math.min(p.maxTokens, maxTokens) } : {}),
      ...(p.reasoningEffort ? { reasoning_effort: p.reasoningEffort } : {}),
    }),
  });
}

/** The model for this request: the vision model for a picture, when one is set. */
const modelFor = (p: Provider, request: AiRequest) => (imageOf(request) && p.visionModel ? p.visionModel : p.model);

function answerText(provider: Provider, payload: unknown): string {
  const data = payload as Record<string, any>;
  if (provider.id === "anthropic") {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
  }
  const message = data?.choices?.[0]?.message?.content;
  const raw =
    typeof message === "string" ? message : Array.isArray(message) ? message.map((part: any) => String(part?.text ?? "")).join("\n") : "";
  // Reasoning models on some hosts put their working inside <think> tags before the answer.
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** What a request is, for the fair-use limits: a text or voice draft, a picture, or a question. */
export type AiKind = "text" | "image" | "ask";

const badRequest = (body: unknown): AiResult => {
  const mode = (body as { mode?: unknown } | null)?.mode;
  return {
    status: 400,
    body: {
      error: "bad_request",
      message:
        mode === "ask"
          ? "Send a question of 3 to 1000 characters. If the model is very large, it may not fit in one question."
          : mode === "chat"
            ? `Send a message of up to ${MAX_CHAT_TEXT} characters. If the workspace is very large, it may not fit in one message.`
            : "Send a description of at least three characters, or a PNG, JPEG, WebP or GIF image under 5 MB.",
    },
  };
};

/** Checks a request before anything is counted or sent: its kind, or the answer that refuses it. */
export function checkAiRequest(body: unknown): { ok: true; kind: AiKind } | { ok: false; result: AiResult } {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success || empty(parsed.data)) return { ok: false, result: badRequest(body) };
  // A chat with the assistant is asking questions, and counts as such; a process read from a picture counts as a picture.
  const mode = parsed.data.mode;
  if (mode === "process") return { ok: true, kind: parsed.data.image ? "image" : "text" };
  return { ok: true, kind: mode === "prompt" ? "text" : mode === "chat" ? "ask" : mode };
}

/**
 * Requests a day for everyone together, so one shared key stays within its provider's allowance.
 * AI_GLOBAL_DAILY_REQUESTS sets it; for Groq's free plan it is 900 unless set, otherwise none.
 */
export function globalDailyLimit(env: AiEnv & { AI_GLOBAL_DAILY_REQUESTS?: string }): number {
  const set = Number(env.AI_GLOBAL_DAILY_REQUESTS);
  if (env.AI_GLOBAL_DAILY_REQUESTS?.trim() && Number.isFinite(set)) return Math.max(0, Math.floor(set));
  return resolveProvider(env)?.id === "groq" ? 900 : 0;
}

/** The tokens a provider's answer says it used. */
function usedTokens(provider: Provider, payload: unknown): number {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return provider.id === "anthropic" ? n(usage.input_tokens) + n(usage.output_tokens) : n(usage.total_tokens) || n(usage.prompt_tokens) + n(usage.completion_tokens);
}

export async function handleAiRequest(body: unknown, env: AiEnv, fetchImpl: typeof fetch = fetch, own?: Provider): Promise<AiResult> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success || empty(parsed.data)) return badRequest(body);
  const provider = own ?? resolveProvider(env);
  if (!provider) {
    return { status: 501, body: { error: "not_configured", message: "No AI provider is configured on the server." } };
  }

  let response: Response;
  try {
    response =
      provider.id === "anthropic"
        ? await callAnthropic(provider, parsed.data, fetchImpl)
        : await callOpenAiStyle(provider, parsed.data, fetchImpl);
  } catch {
    return { status: 502, body: { error: "provider_unreachable", message: "The AI provider could not be reached." } };
  }
  if (!response.ok) {
    // The provider's own error text can contain account details, so only the status is passed on.
    if (response.status === 429) {
      // Free plans allow a few requests a minute; say so plainly instead of a bare status.
      return {
        status: 502,
        body: { error: "rate_limited", message: "The AI provider's free allowance is used up for the moment. Wait a minute and try again.", providerStatus: 429 },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 502,
        body: { error: "provider_error", message: `The AI provider refused the key. ${provider.keyHint ?? "Check AI_API_KEY on the server."}`, providerStatus: response.status },
      };
    }
    return { status: 502, body: { error: "provider_error", message: `The AI provider answered with status ${response.status}.`, providerStatus: response.status } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: 502, body: { error: "bad_response", message: "The AI provider sent an answer that could not be read." } };
  }
  const tokens = usedTokens(provider, payload);
  if (parsed.data.mode === "ask" || parsed.data.mode === "chat") {
    const answer = answerText(provider, payload).trim().slice(0, parsed.data.mode === "chat" ? 12_000 : 8000);
    if (!answer) return { status: 502, body: { error: "bad_response", message: "The AI model sent an empty answer. Try again." }, tokens };
    return { status: 200, body: { answer, engine: `${provider.id}:${modelFor(provider, parsed.data)}` }, tokens };
  }
  if (parsed.data.mode === "process") {
    const process = normalizeProcessDraft(extractJson(answerText(provider, payload)));
    if (!process) return { status: 502, body: { error: "bad_response", message: "The AI answer was not a valid process. Try again, or describe the steps one per line." }, tokens };
    return { status: 200, body: { process, engine: `${provider.id}:${modelFor(provider, parsed.data)}` }, tokens };
  }
  const draft = normalizeDraft(extractJson(answerText(provider, payload)));
  if (!draft) {
    return { status: 502, body: { error: "bad_response", message: "The AI answer was not a valid architecture draft. Try again." }, tokens };
  }
  return { status: 200, body: { draft, engine: `${provider.id}:${modelFor(provider, parsed.data)}` }, tokens };
}
