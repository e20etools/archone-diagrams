import { create } from "zustand";
import { AiError, chatAi, type AiStatus, type ChatMessage } from "../ai/client";
import type { DiagramRecord } from "../approvals";
import { answerFromModel, searchFallback } from "../ask/ask";
import { cloudEnabled } from "../cloud/config";
import { getBackend, useSession } from "../cloud/session";
import { VIEW_TYPE_INFO } from "../catalog";
import type { Workspace } from "../types";
import { assistantContext, diagramTag, focusOf, objectTag, type AssistantFacts } from "./context";

/**
 * The assistant beside every page: a conversation about the workspace. With an AI model it is
 * answered from everything the person can see (see context.ts); without one, the questions the
 * built-in reader can work out are answered from the model and the rest get the matching objects.
 */

export interface ChatTurn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** How an answer was made: by the AI model, read from the model by rule, only matching objects, or a failure. */
  kind?: "ai" | "computed" | "search" | "error";
  engine?: string;
  /** The workspace did not fit whole, so the answer rests on part of it. */
  partial?: boolean;
  at: string;
}

interface AssistantState {
  open: boolean;
  /** The workspace the conversation belongs to. */
  workspaceKey: string | null;
  turns: ChatTurn[];
  busy: boolean;
}

const STORE_KEY = "archone.assistant";
const USE_AI_KEY = "archone.ask.useAi";
const MAX_KEPT = 40;

function load(workspaceKey: string): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(`${STORE_KEY}.${workspaceKey}`);
    const turns = raw ? (JSON.parse(raw) as ChatTurn[]) : [];
    return Array.isArray(turns) ? turns.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string").slice(-MAX_KEPT) : [];
  } catch {
    return [];
  }
}
function save(workspaceKey: string | null, turns: ChatTurn[]) {
  if (!workspaceKey) return;
  try {
    sessionStorage.setItem(`${STORE_KEY}.${workspaceKey}`, JSON.stringify(turns.slice(-MAX_KEPT)));
  } catch {
    // Storage is full or blocked: the conversation lasts as long as the page.
  }
}

export const useAssistant = create<AssistantState>(() => ({ open: false, workspaceKey: null, turns: [], busy: false }));

let nextId = Date.now();
function push(turn: Omit<ChatTurn, "id" | "at">) {
  const full: ChatTurn = { ...turn, id: nextId++, at: new Date().toISOString() };
  useAssistant.setState((s) => {
    const turns = [...s.turns, full].slice(-MAX_KEPT);
    save(s.workspaceKey, turns);
    return { turns };
  });
}

/** Opens the conversation of a workspace: the one kept for this browser tab, if any. */
export function openConversation(workspaceKey: string) {
  const current = useAssistant.getState().workspaceKey;
  if (current !== workspaceKey) useAssistant.setState({ workspaceKey, turns: load(workspaceKey), busy: false });
}

export function newConversation() {
  useAssistant.setState((s) => {
    save(s.workspaceKey, []);
    return { turns: [] };
  });
}
export const setAssistantOpen = (open: boolean) => useAssistant.setState({ open });

/** Whether the person agreed to send what the workspace holds to the AI model. Shared with the Ask page. */
export function getUseAi(): boolean {
  try {
    return localStorage.getItem(USE_AI_KEY) === "yes";
  } catch {
    return false;
  }
}
export function setUseAi(on: boolean) {
  try {
    localStorage.setItem(USE_AI_KEY, on ? "yes" : "no");
  } catch {
    // Private browsing: the choice lasts for this visit only.
  }
}

/* ---------- what is on screen ---------- */

export interface PageInfo {
  diagramId: string | null;
  objectId: string | null;
  /** In words, for the AI model. */
  label: string;
}

const PAGE_NAMES: [RegExp, string][] = [
  [/^\/$/, "the home page"],
  [/^\/diagrams/, "the list of diagrams"],
  [/^\/map/, "the map of all diagrams"],
  [/^\/model/, "the model, with every object and relationship"],
  [/^\/library/, "the component library"],
  [/^\/files/, "the file library"],
  [/^\/ai/, "the drafts made by AI"],
  [/^\/process-mining/, "process mining"],
  [/^\/processes/, "the process landscape"],
  [/^\/bpmn-library/, "the BPMN library, with the elements of BPMN and the workspace's own building blocks"],
  [/^\/impact/, "the impact page"],
  [/^\/analysis/, "the dependencies page"],
  [/^\/health/, "the health of the model"],
  [/^\/checks\/rules/, "the workspace's own rules"],
  [/^\/checks/, "the checks (security, privacy, PCI, NCA ECC, AI agents)"],
  [/^\/decisions/, "the decisions"],
  [/^\/reports/, "the reports"],
  [/^\/document/, "the document of the architecture"],
  [/^\/ask/, "the Ask page"],
  [/^\/versions/, "the versions"],
  [/^\/approvals/, "the approvals of diagrams"],
  [/^\/reviews/, "the reviews of the model"],
  [/^\/scenarios/, "the scenarios"],
  [/^\/audit/, "the audit log"],
  [/^\/settings/, "the settings"],
];

export function pageOf(ws: Workspace, pathname: string, search: string): PageInfo {
  const diagram = /^\/diagram\/([^/?#]+)/.exec(pathname)?.[1];
  const objectParam = new URLSearchParams(search).get("object");
  const objectId = objectParam && ws.objects[objectParam] ? objectParam : (/^\/component\/([^/?#]+)/.exec(pathname)?.[1] ?? null);
  const d = diagram ? ws.diagrams[decodeURIComponent(diagram)] : undefined;
  if (d) return { diagramId: d.id, objectId: null, label: `the editor of the diagram ${diagramTag(d.id)} "${d.name}" (${VIEW_TYPE_INFO[d.viewType].label})` };
  const o = objectId ? ws.objects[objectId] : undefined;
  const where = PAGE_NAMES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "a page of the app";
  return { diagramId: null, objectId: o?.id ?? null, label: o ? `${where}, looking at ${objectTag(o.id)} "${o.name}"` : where };
}

/* ---------- what the database says about diagrams ---------- */

const records = new Map<string, { record: DiagramRecord; at: number; key: string }>();
let recordsQueue: unknown = null;
const FRESH_MS = 45_000;
/** At most this many diagrams are read for a question, the newest and the ones it is about first. */
const MAX_RECORDS = 60;

async function readRecords(ws: Workspace, workspaceId: string, wanted: string[]): Promise<Record<string, DiagramRecord>> {
  const approvals = useSession.getState().approvals;
  // A decision anywhere changes what records say.
  if (approvals !== recordsQueue) {
    records.clear();
    recordsQueue = approvals;
  }
  const newest = Object.values(ws.diagrams)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((d) => d.id);
  const ids = [...new Set([...wanted, ...newest])].filter((id) => ws.diagrams[id]).slice(0, MAX_RECORDS);
  const backend = await getBackend();
  const out: Record<string, DiagramRecord> = {};
  const now = Date.now();
  const todo = ids.filter((id) => {
    const kept = records.get(`${workspaceId}/${id}`);
    if (kept && now - kept.at < FRESH_MS && kept.key === ws.diagrams[id].updatedAt) {
      out[id] = kept.record;
      return false;
    }
    return true;
  });
  // A few at a time, so a large workspace does not flood the database.
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(
      todo.slice(i, i + 6).map(async (id) => {
        try {
          const record = await backend.diagramRecord(workspaceId, id);
          out[id] = record;
          records.set(`${workspaceId}/${id}`, { record, at: Date.now(), key: ws.diagrams[id].updatedAt });
        } catch {
          // A diagram the person cannot read, or a moment of trouble: the rest still answers.
        }
      }),
    );
  }
  return out;
}

/** Everything the assistant may know for a question, from the workspace and, when signed in, the database. */
export async function gatherFacts(ws: Workspace, texts: string[], page: PageInfo): Promise<AssistantFacts> {
  const session = useSession.getState();
  const facts: AssistantFacts = {
    ws,
    page: { diagramId: page.diagramId, objectId: page.objectId },
    me: { name: session.user?.name || ws.userName || "", role: session.role },
    today: new Date().toISOString().slice(0, 10),
  };
  if (!cloudEnabled || !session.workspaceId) return facts;
  const focus = focusOf(ws, texts, facts.page);
  return {
    ...facts,
    records: await readRecords(ws, session.workspaceId, focus.diagramIds).catch(() => ({})),
    queue: session.approvals,
    comments: Object.values(session.comments ?? {}),
    people: session.people,
    reviews: session.reviews,
  };
}

/** How much of the workspace to send: Groq's free plan takes few tokens a minute, the others take a lot. */
export const contextBudget = (engine: string | null | undefined) => (/^groq/i.test(engine ?? "") ? 22_000 : 150_000);

/* ---------- asking ---------- */

export interface AskEnv {
  ws: Workspace;
  ai: AiStatus | null;
  useAi: boolean;
  page: PageInfo;
}

const HISTORY_TURNS = 12;

export async function sendToAssistant(question: string, env: AskEnv): Promise<void> {
  const asked = question.trim().slice(0, 4000);
  if (asked.length < 2 || useAssistant.getState().busy) return;
  const before = useAssistant.getState().turns;
  push({ role: "user", text: asked });
  useAssistant.setState({ busy: true });
  try {
    if (env.ai?.configured && env.useAi) {
      const history: ChatMessage[] = [...before.filter((t) => t.kind !== "error").slice(-(HISTORY_TURNS - 1)), { role: "user" as const, text: asked }].map((t) => ({ role: t.role, content: t.text.slice(0, 6000) }));
      const texts = history.filter((m) => m.role === "user").map((m) => m.content).slice(-3);
      const facts = await gatherFacts(env.ws, texts, env.page);
      const context = assistantContext(facts, texts, contextBudget(env.ai.engine));
      const { answer, engine } = await chatAi(history, context.text, env.page.label);
      push({ role: "assistant", text: answer, kind: "ai", engine, partial: !context.complete });
      return;
    }
    const computed = answerFromModel(env.ws, asked);
    if (computed) {
      push({ role: "assistant", text: computed.text, kind: "computed", engine: computed.engine });
      return;
    }
    const why = !env.ai?.configured
      ? "This is not a question the built-in reader can work out, and no AI model is set up yet. An owner connects one in Settings → Integrations."
      : 'This is not a question the built-in reader can work out. Switch on "Answer with AI" above to have the AI model answer it.';
    const found = searchFallback(env.ws, asked, why);
    push({ role: "assistant", text: found.text, kind: "search", engine: found.engine });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The question could not be answered. Try again.";
    push({ role: "assistant", text: message, kind: "error", engine: error instanceof AiError ? error.code : undefined });
  } finally {
    useAssistant.setState({ busy: false });
  }
}
