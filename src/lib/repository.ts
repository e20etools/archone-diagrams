import { emptyWorkspace } from "./model";
import { workspaceSchema, type Workspace } from "./types";

/**
 * Where the workspace is kept. Phase 1 stores it in the browser, which needs no
 * server or sign-in. A hosted backend (planned for phase 2) implements the same
 * interface, so the rest of the app does not change.
 */
export interface WorkspaceRepository {
  load(): Workspace;
  save(ws: Workspace): void;
}

export const STORAGE_KEY = "archone.workspace.v1";

/** Reads untrusted JSON (a backup file or stored data) into a workspace, or returns null. */
export function parseWorkspace(raw: unknown): Workspace | null {
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const ws = parsed.data;
  // Drop anything that points at objects which are not in the file.
  for (const o of Object.values(ws.objects)) if (o.parentId && !ws.objects[o.parentId]) o.parentId = null;
  for (const r of Object.values(ws.relationships)) {
    if (!ws.objects[r.sourceId] || !ws.objects[r.targetId]) delete ws.relationships[r.id];
  }
  for (const d of Object.values(ws.diagrams)) {
    for (const id of Object.keys(d.nodes)) if (!ws.objects[id]) delete d.nodes[id];
    if (d.scopeId && !ws.objects[d.scopeId]) d.scopeId = null;
  }
  return ws;
}

export class LocalStorageRepository implements WorkspaceRepository {
  constructor(private key = STORAGE_KEY) {}

  load(): Workspace {
    if (typeof localStorage === "undefined") return emptyWorkspace();
    const raw = localStorage.getItem(this.key);
    if (!raw) return emptyWorkspace();
    try {
      const ws = parseWorkspace(JSON.parse(raw));
      if (ws) return ws;
    } catch {
      // fall through to the recovery copy
    }
    // Keep unreadable data for recovery instead of overwriting it silently.
    localStorage.setItem(`${this.key}.unreadable`, raw);
    return emptyWorkspace();
  }

  save(ws: Workspace): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.key, JSON.stringify(ws));
    } catch {
      // Storage is full or blocked; the session keeps working in memory.
    }
  }
}
