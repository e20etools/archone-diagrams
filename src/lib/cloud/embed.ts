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
  /** Its last day has passed. */
  | { status: "expired" }
  /** It asks for a password; `wrong` when one was given and did not open it. */
  | { status: "locked"; wrong: boolean }
  /** Too many wrong passwords; shut for this many minutes. */
  | { status: "throttled"; minutes: number }
  /** Review is on and this diagram has not been approved yet. */
  | { status: "unpublished" }
  | { status: "unreachable" };

function toView(tables: Tables, diagramId: string, source: "working" | "published", at: string): LiveView {
  const ws: Workspace = { ...emptyWorkspace("Shared diagram"), ...fromTables(withoutDangling(tables)) };
  return ws.diagrams[diagramId] ? { status: "ok", source, ws, diagramId, at } : { status: "gone" };
}

/** A live link shows the picture and its details, not the links to repositories and dashboards behind it. */
function withoutLinks(tables: Tables): Tables {
  const strip = <T extends { links?: unknown }>(rows: Record<string, T>) => Object.fromEntries(Object.entries(rows).map(([key, { links: _links, ...rest }]) => [key, rest as T]));
  return { ...tables, objects: strip(tables.objects), relationships: strip(tables.relationships) };
}

type DemoLink = { token: string; workspaceId: string; diagramId: string; protected?: boolean; expiresAt?: string | null; password?: string; failed?: number; lockedUntil?: string };

export async function fetchLiveView(token: string, password = ""): Promise<LiveView> {
  if (demoBackend) {
    try {
      const db = JSON.parse(localStorage.getItem(DEMO_DB_KEY) ?? "{}") as { liveLinks?: DemoLink[]; rows?: Record<string, Tables> };
      const link = db.liveLinks?.find((l) => l.token === token);
      const tables = link && db.rows?.[link.workspaceId];
      if (!link || !tables) return { status: "gone" };
      if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return { status: "expired" };
      if (link.protected) {
        const lockedFor = link.lockedUntil ? new Date(link.lockedUntil).getTime() - Date.now() : 0;
        if (lockedFor > 0) return { status: "throttled", minutes: Math.max(1, Math.ceil(lockedFor / 60_000)) };
        if (!password) return { status: "locked", wrong: false };
        if (password !== link.password) {
          // The same five guesses as the real database, kept in the stand-in server.
          const failed = (link.failed ?? 0) + 1;
          link.failed = failed >= 5 ? 0 : failed;
          link.lockedUntil = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : undefined;
          localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db));
          return { status: "locked", wrong: true };
        }
      }
      return toView(withoutLinks({ ...tables, proposals: {} }), link.diagramId, "working", new Date().toISOString());
    } catch {
      return { status: "unreachable" };
    }
  }
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/embed_view`, {
      method: "POST",
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
      // The password goes in the body of the request, never in the address.
      body: JSON.stringify(password ? { p_token: token, p_password: password } : { p_token: token }),
    });
    if (!response.ok) return { status: "unreachable" };
    const reply = (await response.json()) as { status?: string; wrong?: boolean; minutes?: number; source?: string; diagram?: { id?: string }; nodes?: unknown; objects?: unknown; relationships?: unknown; at?: string };
    if (reply.status === "gone" || reply.status === "unpublished" || reply.status === "expired") return { status: reply.status };
    if (reply.status === "locked") return { status: "locked", wrong: reply.wrong === true };
    if (reply.status === "throttled") return { status: "throttled", minutes: Number(reply.minutes) || 15 };
    if (reply.status !== "ok" || !reply.diagram?.id) return { status: "unreachable" };
    const tables = snapshotToTables({ objects: reply.objects, relationships: reply.relationships, diagrams: [reply.diagram], nodes: reply.nodes });
    return toView(tables, reply.diagram.id, reply.source === "published" ? "published" : "working", reply.at ?? new Date().toISOString());
  } catch {
    return { status: "unreachable" };
  }
}

export const liveLinkUrl = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/embed/${token}`;
