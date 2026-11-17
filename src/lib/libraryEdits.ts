import { newId, nowIso } from "./model";
import { BUILT_IN_LIBRARY, builtInComponent, componentById } from "./library";
import { PROTOCOLS, builtInProtocol, isBuiltInProtocol, type ProtocolInfo, type Transport } from "./library/protocols";
import type { LibraryItem, ModelObject, Workspace } from "./types";

/**
 * Changing the component library and the protocols for one workspace. Nothing built in is
 * touched: a change to a built-in one is kept under its id and wins over it, a removed built-in
 * one is kept as "removed", and the workspace's own are kept with ids of their own. Going back
 * to the built-in one drops the change.
 */

export interface ComponentInput {
  name: string;
  sectionId: string;
  kind: string;
  icon: string;
  profile: string;
  aliases: string;
  provider?: string;
}

export interface ProtocolInput {
  name: string;
  port: string;
  transport: Transport;
  group: string;
  secure: boolean;
  use: string;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
const touch = (ws: Workspace, library: Workspace["library"]): Workspace => ({ ...ws, library, updatedAt: nowIso() });
const isBuiltInComponent = (id: string) => !!builtInComponent(id);

function put(ws: Workspace, item: Omit<LibraryItem, "createdAt" | "updatedAt">): Workspace {
  const at = nowIso();
  const known = ws.library?.[item.id];
  return touch(ws, { ...(ws.library ?? {}), [item.id]: { ...item, createdAt: known?.createdAt ?? at, updatedAt: at } });
}

function drop(ws: Workspace, id: string): Workspace {
  if (!ws.library?.[id]) return ws;
  const { [id]: _gone, ...rest } = ws.library;
  return touch(ws, rest);
}

const cleanComponent = (input: ComponentInput): ComponentInput => ({
  name: input.name.trim().slice(0, 120),
  sectionId: input.sectionId,
  kind: input.kind,
  icon: input.icon,
  profile: input.profile,
  aliases: input.aliases.trim().slice(0, 400),
  ...(input.provider ? { provider: input.provider } : {}),
});

/** Saves a component: a change to the one with this id, or a new one of the workspace's own. */
export function saveComponent(ws: Workspace, input: ComponentInput, id?: string, copiedFrom?: string): { ws: Workspace; id: string } {
  const component = cleanComponent(input);
  if (!component.name) return { ws, id: id ?? "" };
  const key = id ?? `own.${slug(component.name)}-${newId("c").slice(-5)}`;
  const known = ws.library?.[key];
  return { ws: put(ws, { id: key, type: "component", component, ...(copiedFrom ?? known?.copiedFrom ? { copiedFrom: copiedFrom ?? known?.copiedFrom } : {}) }), id: key };
}

/** A copy of a component as one of the workspace's own, named "(copy)". */
export function duplicateComponent(ws: Workspace, id: string): { ws: Workspace; id: string } {
  const source = componentById(id);
  if (!source) return { ws, id: "" };
  return saveComponent(ws, { name: `${source.name} (copy)`, sectionId: source.sectionId, kind: source.kind, icon: source.icon, profile: source.profile, aliases: source.aliases, provider: source.provider }, undefined, id);
}

/** Takes a component out of the library: a built-in one is hidden, the workspace's own is deleted. */
export function removeComponent(ws: Workspace, id: string): Workspace {
  if (isBuiltInComponent(id)) return put(ws, { id, type: "component", removed: true });
  return drop(ws, id);
}

/** Back to the built-in component: the change or the removal is dropped. */
export const resetComponent = (ws: Workspace, id: string): Workspace => (isBuiltInComponent(id) ? drop(ws, id) : ws);

/** Built-in components this workspace removed, to put back. */
export const removedComponents = (ws: Workspace) =>
  Object.values(ws.library ?? {})
    .filter((i) => i.type === "component" && i.removed)
    .map((i) => BUILT_IN_LIBRARY.find((c) => c.id === i.id))
    .filter((c): c is (typeof BUILT_IN_LIBRARY)[number] => !!c);

/** The objects of the model made from a component. */
export const componentUsers = (ws: Workspace, id: string): ModelObject[] => Object.values(ws.objects).filter((o) => o.componentId === id);

/* ---------- protocols ---------- */

const cleanProtocol = (input: ProtocolInput): ProtocolInput => ({
  name: input.name.trim().slice(0, 60),
  port: input.port.trim().slice(0, 40),
  transport: input.transport,
  group: input.group.trim().slice(0, 60) || "Your own",
  secure: input.secure,
  use: input.use.trim().slice(0, 300),
});

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How many connections carry a protocol of this name. */
export const protocolUsers = (ws: Workspace, name: string): number =>
  Object.values(ws.relationships).filter((r) => (r.protocols ?? []).some((p) => same(p.name, name)) || (!r.protocols?.length && same(r.protocol, name))).length;

/** Renames a protocol on every connection that carries it; a port left at the old default follows the new one. */
export function renameOnConnections(ws: Workspace, before: Pick<ProtocolInfo, "name" | "port">, after: Pick<ProtocolInfo, "name" | "port" | "transport">): Workspace {
  let changed = false;
  const relationships = { ...ws.relationships };
  for (const r of Object.values(ws.relationships)) {
    if (!(r.protocols ?? []).some((p) => same(p.name, before.name))) continue;
    const protocols = r.protocols!.map((p) => (same(p.name, before.name) ? { ...p, name: after.name, port: p.port === before.port ? after.port : p.port, transport: after.transport } : p));
    relationships[r.id] = { ...r, protocols, protocol: protocols.map((p) => p.name).join(", "), port: protocols.map((p) => p.port).filter(Boolean).join(", "), updatedAt: nowIso() };
    changed = true;
  }
  return changed ? { ...ws, relationships, updatedAt: nowIso() } : ws;
}

/** Saves a protocol: a change to the one with this id, or a new one of the workspace's own. */
export function saveProtocol(ws: Workspace, input: ProtocolInput, id?: string, copiedFrom?: string): { ws: Workspace; id: string } {
  const protocol = cleanProtocol(input);
  if (!protocol.name) return { ws, id: id ?? "" };
  const key = id ?? `own-proto.${slug(protocol.name)}-${newId("p").slice(-5)}`;
  const known = ws.library?.[key];
  return { ws: put(ws, { id: key, type: "protocol", protocol, ...(copiedFrom ?? known?.copiedFrom ? { copiedFrom: copiedFrom ?? known?.copiedFrom } : {}) }), id: key };
}

/** A copy of a protocol as one of the workspace's own, named "(copy)". */
export function duplicateProtocol(ws: Workspace, id: string): { ws: Workspace; id: string } {
  const source = PROTOCOLS.find((x) => x.id === id);
  if (!source) return { ws, id: "" };
  return saveProtocol(ws, { name: `${source.name} (copy)`, port: source.port, transport: source.transport, group: source.group, secure: source.secure, use: source.use }, undefined, id);
}

/** Takes a protocol out of the catalogue: a built-in one is hidden, the workspace's own is deleted. Connections keep what they carry. */
export function removeProtocol(ws: Workspace, id: string): Workspace {
  if (isBuiltInProtocol(id)) return put(ws, { id, type: "protocol", removed: true });
  return drop(ws, id);
}

export const resetProtocol = (ws: Workspace, id: string): Workspace => (isBuiltInProtocol(id) ? drop(ws, id) : ws);

/** Built-in protocols this workspace removed, to put back. */
export const removedProtocols = (ws: Workspace) =>
  Object.values(ws.library ?? {})
    .filter((i) => i.type === "protocol" && i.removed)
    .map((i) => builtInProtocol(i.id))
    .filter((x): x is ProtocolInfo => !!x);
