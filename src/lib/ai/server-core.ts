import { z } from "zod";
import { buildAskSystemPrompt, buildAskText, buildSystemPrompt, buildUserText } from "./prompt";
import { normalizeDraft } from "./schema";

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
 */

export interface AiEnv {
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  AI_VISION_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  LOVABLE_API_KEY?: string;
}

export interface AiResult {
  status: number;
  body: Record<string, unknown>;
}

const MAX_TEXT = 12_000;
const MAX_IMAGE_BASE64 = 7_000_000; // about 5 MB of image
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const MAX_QUESTION = 1000;
export const MAX_CONTEXT = 240_000;

const requestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("prompt"), text: z.string().trim().min(3).max(MAX_TEXT) }),
  z.object({
    mode: z.literal("image"),
    text: z.string().max(2000).optional(),
    image: z.object({ mime: z.enum(IMAGE_TYPES), data: z.string().min(100).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/=]+$/) }),
  }),
  // A question about the model. The model travels with the question, as text; the server keeps none of it.
  z.object({ mode: z.literal("ask"), question: z.string().trim().min(3).max(MAX_QUESTION), context: z.string().max(MAX_CONTEXT) }),
]);
export type AiRequest = z.infer<typeof requestSchema>;

interface Provider {
  id: "anthropic" | "openai" | "groq" | "lovable" | "openai-compatible";
  key: string;
  model: string;
  baseUrl: string;
  /** Used for drafting from a picture, when set. */
  visionModel?: string;
  /** A ceiling on the answer's length, for plans that count it against a per-minute allowance. */
  maxTokens?: number;
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
        return key && env.AI_MODEL ? { id, key, model: env.AI_MODEL, visionModel: env.AI_VISION_MODEL, baseUrl: env.AI_BASE_URL || "https://api.openai.com/v1" } : null;
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

/** What is sent to the model: the instruction, and the person's text (with a picture, when drafting from one). */
function messageFor(request: AiRequest): { system: string; text: string; maxTokens: number } {
  if (request.mode === "ask") return { system: buildAskSystemPrompt(), text: buildAskText(request.question, request.context), maxTokens: 1500 };
  return { system: buildSystemPrompt(), text: buildUserText(request.mode, request.text ?? ""), maxTokens: 8000 };
}

async function callAnthropic(p: Provider, request: AiRequest, fetchImpl: typeof fetch): Promise<Response> {
  const { system, text, maxTokens } = messageFor(request);
  const content: unknown[] = [];
  if (request.mode === "image") {
    content.push({ type: "image", source: { type: "base64", media_type: request.image.mime, data: request.image.data } });
  }
  content.push({ type: "text", text });
  return fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  });
}

async function callOpenAiStyle(p: Provider, request: AiRequest, fetchImpl: typeof fetch): Promise<Response> {
  const { system, text, maxTokens } = messageFor(request);
  // Plain text for text requests: some OpenAI-style hosts accept a list of parts only for vision models.
  const content: unknown =
    request.mode === "image"
      ? [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:${request.image.mime};base64,${request.image.data}` } },
        ]
      : text;
  return fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: modelFor(p, request),
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      ...(p.maxTokens ? { max_tokens: Math.min(p.maxTokens, maxTokens) } : {}),
    }),
  });
}

/** The model for this request: the vision model for a picture, when one is set. */
const modelFor = (p: Provider, request: AiRequest) => (request.mode === "image" && p.visionModel ? p.visionModel : p.model);

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

export async function handleAiRequest(body: unknown, env: AiEnv, fetchImpl: typeof fetch = fetch): Promise<AiResult> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const asking = (body as { mode?: unknown } | null)?.mode === "ask";
    return {
      status: 400,
      body: {
        error: "bad_request",
        message: asking
          ? "Send a question of 3 to 1000 characters. If the model is very large, it may not fit in one question."
          : "Send a description of at least three characters, or a PNG, JPEG, WebP or GIF image under 5 MB.",
      },
    };
  }
  const provider = resolveProvider(env);
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
        body: { error: "provider_error", message: "The AI provider refused the key. Check AI_API_KEY on the server.", providerStatus: response.status },
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
  if (parsed.data.mode === "ask") {
    const answer = answerText(provider, payload).trim().slice(0, 8000);
    if (!answer) return { status: 502, body: { error: "bad_response", message: "The AI model sent an empty answer. Try again." } };
    return { status: 200, body: { answer, engine: `${provider.id}:${modelFor(provider, parsed.data)}` } };
  }
  const draft = normalizeDraft(extractJson(answerText(provider, payload)));
  if (!draft) {
    return { status: 502, body: { error: "bad_response", message: "The AI answer was not a valid architecture draft. Try again." } };
  }
  return { status: 200, body: { draft, engine: `${provider.id}:${modelFor(provider, parsed.data)}` } };
}
