import type { BoxRecord } from "../approvals";
import { emptyWorkspace } from "../model";
import type { Workspace } from "../types";
import { snapshotToTables } from "./collab";
import { DEMO_DB_KEY, demoBackend, supabaseKey, supabaseUrl } from "./config";
import { demoFingerprint, type DemoApprovalDb } from "./demoApprovals";
import { fromTables, withoutDangling, type Tables } from "./tables";

/**
 * A verified copy, as anyone with its link sees it, without signing in: the diagram as it was
 * published, its information box, and whether the diagram in the workspace still matches it.
 * On Supabase the database function publication_view() decides what is returned.
 */

export interface PublicationFile {
  sha256: string;
  name: string;
  at: string;
}
export type PublicationView =
  | {
      status: "ok";
      ws: Workspace;
      diagramId: string;
      record: BoxRecord;
      fingerprint: string;
      version: number | null;
      publishedAt: string;
      publishedBy: string;
      expiresAt: string | null;
      note: string;
      files: PublicationFile[];
      /** The diagram in the workspace matches this copy, has changed since, or was deleted. */
      current: "same" | "changed" | "removed";
      /** Its newest approved version, to tell a reader a newer one exists. */
      latestVersion: number | null;
      at: string;
    }
  | { status: "expired"; expiredAt: string; name: string; company: string }
  | { status: "gone" }
  | { status: "unreachable" };

const toWorkspace = (tables: Tables): Workspace => ({ ...emptyWorkspace("Verified copy"), ...fromTables(withoutDangling(tables)) });

export async function fetchPublication(token: string): Promise<PublicationView> {
  if (demoBackend) {
    try {
      const db = JSON.parse(localStorage.getItem(DEMO_DB_KEY) ?? "{}") as DemoApprovalDb;
      const row = db.publications?.find((p) => p.token === token);
      if (!row || row.revokedAt) return { status: "gone" };
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return { status: "expired", expiredAt: row.expiresAt, name: row.record.name, company: row.record.company };
      row.views += 1;
      localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db));
      const tables = db.rows?.[row.workspaceId];
      const now = tables?.diagrams[row.diagramId] ? await demoFingerprint(tables, row.diagramId) : null;
      const latest = (db.approvalRequests?.[row.workspaceId] ?? []).filter((r) => r.diagramId === row.diagramId && r.status === "approved").map((r) => r.version);
      return {
        status: "ok",
        ws: toWorkspace(row.tables),
        diagramId: row.diagramId,
        record: row.record,
        fingerprint: row.fingerprint,
        version: row.version,
        publishedAt: row.createdAt,
        publishedBy: (() => {
          const user = Object.values(db.users ?? {}).find((u) => u.id === row.createdBy);
          return user ? user.name || user.email : "";
        })(),
        expiresAt: row.expiresAt,
        note: row.note,
        files: row.files,
        current: now === null ? "removed" : now === row.fingerprint ? "same" : "changed",
        latestVersion: latest.length ? Math.max(...latest) : null,
        at: new Date().toISOString(),
      };
    } catch {
      return { status: "unreachable" };
    }
  }
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/publication_view`, {
      method: "POST",
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }),
    });
    if (!response.ok) return { status: "unreachable" };
    const reply = (await response.json()) as Record<string, unknown> & { status?: string; snapshot?: { diagram?: { id?: string }; nodes?: unknown; objects?: unknown; relationships?: unknown } };
    if (reply.status === "gone") return { status: "gone" };
    if (reply.status === "expired") return { status: "expired", expiredAt: String(reply.expiredAt ?? ""), name: String(reply.name ?? ""), company: String(reply.company ?? "") };
    const snapshot = reply.snapshot;
    if (reply.status !== "ok" || !snapshot?.diagram?.id) return { status: "unreachable" };
    const tables = snapshotToTables({ objects: snapshot.objects, relationships: snapshot.relationships, diagrams: [snapshot.diagram], nodes: snapshot.nodes });
    const current = reply.current === "same" || reply.current === "removed" ? reply.current : "changed";
    return {
      status: "ok",
      ws: toWorkspace(tables),
      diagramId: snapshot.diagram.id,
      record: reply.record as BoxRecord,
      fingerprint: String(reply.fingerprint ?? ""),
      version: typeof reply.version === "number" ? reply.version : null,
      publishedAt: String(reply.publishedAt ?? ""),
      publishedBy: String(reply.publishedBy ?? ""),
      expiresAt: typeof reply.expiresAt === "string" ? reply.expiresAt : null,
      note: String(reply.note ?? ""),
      files: Array.isArray(reply.files) ? (reply.files as PublicationFile[]) : [],
      current,
      latestVersion: typeof reply.latestVersion === "number" ? reply.latestVersion : null,
      at: String(reply.at ?? new Date().toISOString()),
    };
  } catch {
    return { status: "unreachable" };
  }
}
