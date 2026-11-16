import { create } from "zustand";
import { applyProposal, type ApplyResult } from "./ai/proposals";
import {
  createObject,
  createRelationship,
  type ObjectInput,
  type RelationshipInput,
} from "./model";
import { cloudEnabled } from "./cloud/config";
import { emptyWorkspace } from "./model";
import { LocalStorageRepository } from "./repository";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";
import { createView, ensureDetailDiagram } from "./views";
import type { DiagramInput } from "./model";

const repository = new LocalStorageRepository();
const HISTORY_LIMIT = 60;

interface State {
  ws: Workspace;
  past: Workspace[];
  future: Workspace[];
  /** Applies a change to the workspace and records it for undo. */
  apply: (change: (ws: Workspace) => Workspace) => void;
  /** Swaps in a whole workspace (demo data, a restored backup) and clears undo history. */
  replace: (ws: Workspace) => void;
  /** Loads a workspace that came from the server: no edit check, history cleared. */
  adopt: (ws: Workspace) => void;
  /**
   * Applies a change made by someone else. It is not an undo step, and it is applied to the
   * undo history as well, so that undoing your own edit never takes their change away.
   */
  applyRemote: (change: (ws: Workspace) => Workspace) => void;
  undo: () => void;
  redo: () => void;
}

/** In hosted mode the signed-in person's role decides whether they may change the model. */
let editGuard: (() => boolean) | null = null;
export function setEditGuard(guard: (() => boolean) | null): void {
  editGuard = guard;
}
const mayEdit = () => !editGuard || editGuard();

/** In hosted mode a person may be limited to part of the model. The guard returns true when it refused the change. */
let changeGuard: ((before: Workspace, after: Workspace) => boolean) | null = null;
export function setChangeGuard(guard: ((before: Workspace, after: Workspace) => boolean) | null): void {
  changeGuard = guard;
}

export const useStore = create<State>((set, get) => ({
  // In hosted mode the workspace comes from the server after sign-in; the browser copy is left untouched.
  ws: cloudEnabled ? emptyWorkspace() : repository.load(),
  past: [],
  future: [],
  apply: (change) => {
    if (!mayEdit()) return;
    const current = get().ws;
    const next = change(current);
    if (next === current) return;
    if (changeGuard?.(current, next)) return;
    set({ ws: next, past: [...get().past.slice(-(HISTORY_LIMIT - 1)), current], future: [] });
  },
  replace: (ws) => {
    if (!mayEdit()) return;
    // A hosted workspace keeps its own name and the signed-in person's name whatever is loaded into it.
    const { name, userName } = get().ws;
    if (changeGuard?.(get().ws, ws)) return;
    set({ ws: cloudEnabled ? { ...ws, name, userName } : ws, past: [], future: [] });
  },
  adopt: (ws) => set({ ws, past: [], future: [] }),
  applyRemote: (change) => {
    const { ws, past, future } = get();
    set({ ws: change(ws), past: past.map(change), future: future.map(change) });
  },
  undo: () => {
    const { past, ws, future } = get();
    if (!past.length || !mayEdit()) return;
    set({ ws: past[past.length - 1], past: past.slice(0, -1), future: [ws, ...future] });
  },
  redo: () => {
    const { past, ws, future } = get();
    if (!future.length || !mayEdit()) return;
    set({ ws: future[0], past: [...past, ws], future: future.slice(1) });
  },
}));

let timer: ReturnType<typeof setTimeout> | undefined;
const flush = () => {
  clearTimeout(timer);
  if (!cloudEnabled) repository.save(useStore.getState().ws);
};
useStore.subscribe((state, previous) => {
  if (cloudEnabled || state.ws === previous.ws) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
});
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}

export const useWorkspace = () => useStore((s) => s.ws);
export const apply = (change: (ws: Workspace) => Workspace) => useStore.getState().apply(change);

/* Actions that hand back what they created. */

export function addObject(input: ObjectInput): ModelObject {
  let created!: ModelObject;
  apply((ws) => {
    const made = createObject(ws, input);
    created = made.object;
    return made.ws;
  });
  return created;
}

export function addRelationship(input: RelationshipInput): Relationship | null {
  let result: Relationship | null = null;
  apply((ws) => {
    const made = createRelationship(ws, input);
    result = made.relationship;
    return made.ws;
  });
  return result;
}

export function addView(input: DiagramInput): Diagram {
  let created!: Diagram;
  apply((ws) => {
    const made = createView(ws, input);
    created = made.diagram;
    return made.ws;
  });
  return created;
}

/** Opens the diagram of an object's inside, creating it on first use. Returns the diagram id. */
export function zoomInto(objectId: string): string | null {
  let diagramId: string | null = null;
  const current = useStore.getState().ws;
  const made = ensureDetailDiagram(current, objectId);
  diagramId = made.diagramId;
  if (made.created) apply(() => made.ws);
  return diagramId;
}

export function applyProposalNow(proposalId: string): ApplyResult {
  const { ws } = useStore.getState();
  const result = applyProposal(ws, proposalId, ws.userName);
  if (result.ws !== ws) apply(() => result.ws);
  return result;
}
