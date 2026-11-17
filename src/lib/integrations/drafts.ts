import { findByName, newId, nowIso } from "../model";
import type { Proposal, ProposedObject, Workspace } from "../types";
import type { DirectoryGroup, DirectoryPerson } from "./connectors";

/**
 * People and groups from a directory as a draft: each group a team and each person a person,
 * both "Person or team" objects, with their email, title and department as fields and the
 * teams a person is in as tags. Nothing is drawn; they become owners to choose from.
 */
export function directoryToProposal(ws: Workspace, directory: { people: DirectoryPerson[]; groups: DirectoryGroup[] }, source: string): Proposal {
  const teamsOf = new Map<string, string[]>();
  for (const g of directory.groups) for (const m of g.members) teamsOf.set(m, [...(teamsOf.get(m) ?? []), g.name]);
  const objects: ProposedObject[] = [];
  const add = (o: Omit<ProposedObject, "key" | "decision" | "matchId" | "parentKey">) => objects.push({ ...o, key: `o${objects.length + 1}`, parentKey: null, decision: "pending", matchId: findByName(ws, o.name)?.id ?? null });
  for (const g of directory.groups.slice(0, 500)) {
    add({ name: g.name.slice(0, 300), typeId: "actor", description: (g.description || `A group of ${g.members.length} people.`).slice(0, 2000), technology: "Team", tags: ["team"], fields: { members: String(g.members.length), source } });
  }
  for (const p of directory.people.slice(0, 3000)) {
    const fields = Object.fromEntries(Object.entries({ email: p.email, title: p.title, department: p.department, source }).filter(([, v]) => v).map(([k, v]) => [k, v.slice(0, 300)]));
    add({ name: p.name.slice(0, 300), typeId: "actor", description: [p.title, p.department].filter(Boolean).join(", ").slice(0, 2000), technology: "Person", tags: ["person", ...(teamsOf.get(p.id) ?? []).slice(0, 20)], fields });
  }
  if (!objects.length) throw new Error(`${source} returned no people or groups.`);
  return {
    id: newId("prop"),
    origin: "import",
    importKind: "directory",
    withoutDiagram: true,
    source,
    engine: "Directory import",
    notes: `${directory.groups.length} groups and ${directory.people.length} people from ${source}${directory.people.length > 3000 ? " (the first 3,000 people)" : ""}. Accept the ones who own or use what you model; they can then be chosen as owners.`,
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: null,
    objects,
    relationships: [],
  };
}
