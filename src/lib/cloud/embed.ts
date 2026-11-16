import { emptyWorkspace } from "../model";
import type { Workspace } from "../types";
import { snapshotToTables } from "./collab";
import { DEMO_DB_KEY, demoBackend, supabaseKey, supabaseUrl } from "./config";
import { fromTables, withoutDangling, type Tables } from "./tables";

/**
 * What a live link shows. Read without signing in: the token in the link is the permission.
 * On Supabase the database function embed_view() decides what is returned.
 */

export type LiveView =
  | { status: "ok"; source: "working" | "published"; ws: Workspace; diagramId: string; at: string }
  /** Switched off, mistyped, or its diagram was deleted. */
  | { status: "gone" }
  /** Review is on and this diagram has not been approved yet. */
  | { status: "unpublished" }
  | { status: "unreachable" };

function toView(tables: Tables, diagramId: string, source: "working" | "published", at: string): LiveView {
  const ws: Workspace = { ...emptyWorkspace("Shared diagram"), ...fromTables(withoutDangling(tables)) };
  return ws.diagrams[diagramId] ? { status: "ok", source, ws, diagramId, at } : { status: "gone" };
}

export async function fetchLiveView(token: string): Promise<LiveView> {
  if (demoBackend) {
    try {
      const db = JSON.parse(localStorage.getItem(DEMO_DB_KEY) ?? "{}") as { liveLinks?: { token: string; workspaceId: string; diagramId: string }[]; rows?: Record<string, Tables> };
      const link = db.liveLinks?.find((l) => l.token === token);
      const tables = link && db.rows?.[link.workspaceId];
      return link && tables ? toView({ ...tables, proposals: {} }, link.diagramId, "working", new Date().toISOString()) : { status: "gone" };
    } catch {
      return { status: "unreachable" };
    }
  }
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/embed_view`, {
      method: "POST",
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }),
    });
    if (!response.ok) return { status: "unreachable" };
    const reply = (await response.json()) as { status?: string; source?: string; diagram?: { id?: string }; nodes?: unknown; objects?: unknown; relationships?: unknown; at?: string };
    if (reply.status === "gone" || reply.status === "unpublished") return { status: reply.status };
    if (reply.status !== "ok" || !reply.diagram?.id) return { status: "unreachable" };
    const tables = snapshotToTables({ objects: reply.objects, relationships: reply.relationships, diagrams: [reply.diagram], nodes: reply.nodes });
    return toView(tables, reply.diagram.id, reply.source === "published" ? "published" : "working", reply.at ?? new Date().toISOString());
  } catch {
    return { status: "unreachable" };
  }
}

export const liveLinkUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/embed/${token}`;
