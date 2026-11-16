import type { Workspace } from "../types";
import { BackendError } from "./backend";
import {
  TABLE_NAMES,
  applyChangeSet,
  countChanges,
  diffTables,
  fromTables,
  isEmptyChange,
  patchTables,
  sameValue,
  toTables,
  withoutDangling,
  type ChangeSet,
  type Tables,
} from "./tables";

/**
 * Keeps one browser's workspace and the hosted copy in step.
 *
 * `shadow` is what the server is known to hold. Whatever differs between the shadow and the
 * current workspace is a local edit that still has to be saved; that difference is pushed.
 * A change from someone else updates the shadow and, unless the same row has an unsaved local
 * edit, the workspace. When two people change the same row, the last save wins.
 */

export type SyncState =
  | { kind: "saved" }
  | { kind: "saving"; pending: number }
  | { kind: "offline"; pending: number }
  | { kind: "readonly" }
  | { kind: "error"; message: string };

export interface SyncOptions {
  getWorkspace(): Workspace;
  /** Applies a change that did not come from this person: no undo step, and undo history is rebased over it. */
  applyRemote(change: (ws: Workspace) => Workspace): void;
  push(change: ChangeSet): Promise<void>;
  load(): Promise<Tables>;
  canEdit(): boolean;
  onState(state: SyncState): void;
  debounceMs?: number;
  retryMs?: number;
}

export class SyncEngine {
  private shadow: Tables;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private again = false;
  private failures = 0;
  private closed = false;
  private state: SyncState = { kind: "saved" };

  constructor(
    private options: SyncOptions,
    initial: Tables,
  ) {
    this.shadow = initial;
  }

  get current(): SyncState {
    return this.state;
  }
  /** True while there are local edits the server has not confirmed. */
  get dirty(): boolean {
    return !isEmptyChange(diffTables(this.shadow, toTables(this.options.getWorkspace())));
  }

  private setState(state: SyncState) {
    if (sameValue(state, this.state)) return;
    this.state = state;
    this.options.onState(state);
  }

  /** Call after every local change to the workspace. */
  localChanged(): void {
    if (this.closed) return;
    // Say so at once: "Saved" must never be shown while an edit is still waiting to go out.
    if (this.state.kind === "saved") {
      const waiting = countChanges(diffTables(this.shadow, toTables(this.options.getWorkspace())));
      if (waiting > 0 && this.options.canEdit()) this.setState({ kind: "saving", pending: waiting });
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.options.debounceMs ?? 400);
  }

  /** Saves now instead of waiting for the pause after the last edit. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.run();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    const change = diffTables(this.shadow, toTables(this.options.getWorkspace()));
    if (isEmptyChange(change)) {
      if (this.state.kind !== "error" && this.state.kind !== "readonly") this.setState({ kind: "saved" });
      return;
    }
    if (!this.options.canEdit()) {
      this.revert();
      this.setState({ kind: "readonly" });
      return;
    }
    this.busy = true;
    this.setState({ kind: "saving", pending: countChanges(change) });
    let retryIn: number | null = null;
    try {
      await this.options.push(change);
      // The shadow takes exactly what was sent; edits made meanwhile stay a difference and go next.
      this.shadow = patchTables(this.shadow, change);
      this.failures = 0;
    } catch (error) {
      const code = error instanceof BackendError ? error.code : "unknown";
      if (code === "network") {
        this.failures++;
        retryIn = Math.min(30_000, (this.options.retryMs ?? 2000) * 2 ** Math.min(this.failures - 1, 4));
        this.setState({ kind: "offline", pending: countChanges(change) });
      } else if (code === "forbidden") {
        this.revert();
        this.setState({ kind: "readonly" });
      } else {
        // The server refused the change. Take the server's copy rather than keep retrying something it will not accept.
        await this.reloadDiscardingLocal(error instanceof Error ? error.message : "The change could not be saved.");
      }
    } finally {
      this.busy = false;
    }
    if (this.closed) return;
    if (retryIn !== null) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.run(), retryIn);
      return;
    }
    if (this.again || this.dirty) {
      this.again = false;
      await this.run();
    } else if (this.state.kind === "saving") {
      this.setState({ kind: "saved" });
    }
  }

  /** Puts the workspace back to what the server holds, dropping unsaved local edits. */
  private revert(): void {
    const server = this.shadow;
    this.options.applyRemote((ws) => ({ ...ws, ...fromTables(server) }));
  }

  private async reloadDiscardingLocal(message: string): Promise<void> {
    try {
      this.shadow = withoutDangling(await this.options.load());
      this.revert();
      this.setState({ kind: "error", message: `${message} The latest saved version was loaded again.` });
    } catch {
      this.setState({ kind: "error", message });
    }
  }

  /** Changes that arrived from the server, including echoes of this browser's own saves. */
  remote(change: ChangeSet): void {
    if (this.closed) return;
    const local = toTables(this.options.getWorkspace());
    const news: ChangeSet = {};
    const apply: ChangeSet = {};
    for (const table of TABLE_NAMES) {
      const rows = change[table];
      if (!rows) continue;
      const known = this.shadow[table] as Record<string, unknown>;
      const mine = local[table] as Record<string, unknown>;
      for (const [key, value] of Object.entries(rows)) {
        const before = known[key] ?? null;
        if (sameValue(before, value)) continue; // the echo of a save, or nothing new
        ((news as Record<string, Record<string, unknown>>)[table] ??= {})[key] = value;
        const unsavedLocalEdit = !sameValue(mine[key] ?? null, before);
        if (!unsavedLocalEdit) ((apply as Record<string, Record<string, unknown>>)[table] ??= {})[key] = value;
      }
    }
    if (isEmptyChange(news)) return;
    this.shadow = patchTables(this.shadow, news);
    if (!isEmptyChange(apply)) this.options.applyRemote((ws) => applyChangeSet(ws, apply));
    // Cleaning up a dangling reference is a local edit that has to be saved too.
    this.localChanged();
  }

  /** After a reconnection: fetch everything, keep unsaved local edits, take the rest from the server. */
  async resync(): Promise<void> {
    if (this.closed) return;
    let server: Tables;
    try {
      server = await this.options.load();
    } catch {
      return; // still offline; the next reconnection tries again
    }
    if (this.closed) return;
    const local = toTables(this.options.getWorkspace());
    const merged: Tables = { ...server };
    for (const table of TABLE_NAMES) {
      const known = this.shadow[table] as Record<string, unknown>;
      const mine = local[table] as Record<string, unknown>;
      const next = { ...(server[table] as Record<string, unknown>) };
      for (const key of new Set([...Object.keys(known), ...Object.keys(mine)])) {
        if (sameValue(mine[key] ?? null, known[key] ?? null)) continue; // not edited here
        if (key in mine) next[key] = mine[key];
        else delete next[key];
      }
      (merged as unknown as Record<string, unknown>)[table] = next;
    }
    this.shadow = server;
    const result = withoutDangling(merged);
    this.options.applyRemote((ws) => ({ ...ws, ...fromTables(result) }));
    this.localChanged();
  }
}
