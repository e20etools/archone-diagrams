import { emptyWorkspace } from "../model";
import { redactForTrust, type TrustPage } from "../trust";
import type { Workspace } from "../types";
import { snapshotToTables } from "./collab";
import { DEMO_DB_KEY, demoBackend, supabaseKey, supabaseUrl } from "./config";
import { fromTables, withoutDangling, type Tables } from "./tables";

/** What the public trust page receives. Read without signing in: the address is the permission. */
export type TrustView =
  | { status: "ok"; source: "working" | "published"; title: string; intro: string; contact: string; ws: Workspace; diagramId: string | null; at: string }
  /** Switched off or mistyped. */
  | { status: "gone" }
  /** Review is on and nothing has been approved yet. */
  | { status: "unpublished" }
  | { status: "unreachable" };

const toWorkspace = (tables: Tables, title: string): Workspace => ({ ...emptyWorkspace(title), ...fromTables(withoutDangling(tables)) });

export async function fetchTrustView(token: string): Promise<TrustView> {
  if (demoBackend) {
    try {
      const db = JSON.parse(localStorage.getItem(DEMO_DB_KEY) ?? "{}") as { trustPages?: Record<string, TrustPage>; rows?: Record<string, Tables> };
      const found = Object.entries(db.trustPages ?? {}).find(([, page]) => page.token === token && page.enabled);
      const tables = found && db.rows?.[found[0]];
      if (!found || !tables) return { status: "gone" };
      const page = found[1];
      const ws = toWorkspace(redactForTrust(tables, page.diagramId), page.title);
      return { status: "ok", source: "working", title: page.title, intro: page.intro, contact: page.contact, ws, diagramId: page.diagramId && ws.diagrams[page.diagramId] ? page.diagramId : null, at: new Date().toISOString() };
    } catch {
      return { status: "unreachable" };
    }
  }
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/trust_view`, {
      method: "POST",
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }),
    });
    if (!response.ok) return { status: "unreachable" };
    const reply = (await response.json()) as { status?: string; source?: string; title?: string; intro?: string; contact?: string; diagram?: { id?: string } | null; nodes?: unknown; objects?: unknown; relationships?: unknown; at?: string };
    if (reply.status === "gone" || reply.status === "unpublished") return { status: reply.status };
    if (reply.status !== "ok") return { status: "unreachable" };
    const tables = snapshotToTables({ objects: reply.objects, relationships: reply.relationships, diagrams: reply.diagram ? [reply.diagram] : [], nodes: reply.nodes });
    const ws = toWorkspace(tables, reply.title ?? "");
    const diagramId = reply.diagram?.id && ws.diagrams[reply.diagram.id] ? reply.diagram.id : null;
    return { status: "ok", source: reply.source === "published" ? "published" : "working", title: reply.title ?? "", intro: reply.intro ?? "", contact: reply.contact ?? "", ws, diagramId, at: reply.at ?? new Date().toISOString() };
  } catch {
    return { status: "unreachable" };
  }
}

export const trustPageUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/trust/${token}`;
