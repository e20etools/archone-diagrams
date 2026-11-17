import { findByName, newId, normalizeName, nowIso } from "../model";
import { isKnownType, objectType } from "../catalog";
import type { Proposal, ProposedObject, ProposedRelationship, Workspace } from "../types";
import { looksLikeAws, looksLikeAzure, looksLikeDiscoveryRows, looksLikeGcp, looksLikeServiceNow, readAws, readAzure, readDiscoveryRows, readGcp, readServiceNow } from "./discovery";
import { InventoryError, type Inventory } from "./model";
import { looksLikeArm, looksLikeBicep, looksLikeCloudFormation, looksLikeCompose, looksLikeKubernetes, looksLikePulumi, parseStructured, readArm, readBicep, readCloudFormation, readCompose, readKubernetes, readPulumi } from "./templates";
import { looksLikeTerraform, looksLikeTerraformJson, readTerraformHcl, readTerraformJson } from "./terraform";

export { InventoryError, type Inventory } from "./model";

/** The file names this reads, for a file picker. */
export const INVENTORY_EXTENSIONS = [".tf", ".hcl", ".tfstate", ".json", ".yaml", ".yml", ".bicep", ".jsonl"];

/** Which source the file came from, when the person says (a discovery tool's rows look alike). */
export type InventoryHint = "bmc" | "device42" | null;

/**
 * Reads infrastructure as code, a cloud inventory or a discovery export, whichever the file is.
 * Answers null when the file is none of these, so other readers can try it.
 */
export function readInventory(fileName: string, source: string, hint: InventoryHint = null): Inventory | null {
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase() : "";
  if (extension === "tf" || extension === "hcl" || (extension !== "json" && looksLikeTerraform(source))) return readTerraformHcl(source, fileName);
  if (extension === "bicep" || looksLikeBicep(source)) return readBicep(source, fileName);
  let docs: unknown[];
  try {
    docs = parseStructured(source);
  } catch (e) {
    if (["json", "yaml", "yml", "tfstate", "jsonl"].includes(extension)) throw new InventoryError(`"${fileName}" could not be read: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
  const first = docs[0];
  if (looksLikeTerraformJson(first)) return readTerraformJson(first, fileName);
  if (looksLikeCloudFormation(first)) return readCloudFormation(first, fileName);
  if (looksLikeArm(first)) return readArm(first, fileName);
  if (looksLikePulumi(first)) return readPulumi(first, fileName);
  if (looksLikeCompose(first)) return readCompose(first, fileName);
  if (looksLikeKubernetes(docs)) return readKubernetes(docs, fileName);
  if (looksLikeAws(first)) return readAws(first, fileName);
  if (looksLikeAzure(first)) return readAzure(first, fileName);
  if (looksLikeGcp(first)) return readGcp(first, fileName);
  if (looksLikeServiceNow(first)) return readServiceNow(first, fileName);
  if (looksLikeDiscoveryRows(first)) return readDiscoveryRows(first, fileName, hint === "bmc" ? "BMC Helix Discovery" : hint === "device42" ? "Device42" : "a discovery tool");
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An inventory as a draft for review: one object per resource, one relationship per link, zones holding what sits in them. */
export function inventoryToProposal(ws: Workspace, inventory: Inventory, kind: "iac" | "discovery", source: string): Proposal {
  if (inventory.items.length > 3000 || inventory.links.length > 6000) throw new InventoryError("This holds more than 3000 resources or 6000 links. Import it in smaller parts.");
  const keyOf = new Map<string, string>();
  const keyByName = new Map<string, string>();
  const objects: ProposedObject[] = [];
  let merged = 0;
  for (const item of inventory.items) {
    // The same name twice in one inventory is usually two things (two subnets called "private"); the type tells them apart.
    const nameKey = `${normalizeName(item.name)}|${item.resourceType}`;
    const known = keyByName.get(nameKey);
    if (known && item.typeId !== "zone") {
      keyOf.set(item.id, known);
      merged++;
      continue;
    }
    const key = `o${objects.length + 1}`;
    keyOf.set(item.id, key);
    keyByName.set(nameKey, key);
    objects.push({
      key,
      name: item.name.slice(0, 300) || item.id.slice(0, 300),
      typeId: isKnownType(item.typeId) ? item.typeId : "application",
      description: item.description.slice(0, 2000),
      technology: item.technology.slice(0, 300),
      parentKey: null,
      decision: "pending",
      matchId: null,
      ...(item.componentId ? { componentId: item.componentId } : {}),
      ...(item.tags.length ? { tags: item.tags.slice(0, 30) } : {}),
      ...(Object.keys(item.fields).length ? { fields: Object.fromEntries(Object.entries(item.fields).slice(0, 30).map(([k, v]) => [k.slice(0, 60), v.slice(0, 300)])) } : {}),
    });
  }
  const byKey = new Map(objects.map((o) => [o.key, o]));
  for (const item of inventory.items) {
    if (!item.parentId) continue;
    const own = byKey.get(keyOf.get(item.id) ?? "");
    const parent = byKey.get(keyOf.get(item.parentId) ?? "");
    if (own && parent && parent !== own && objectType(parent.typeId).level < objectType(own.typeId).level) own.parentKey = parent.key;
  }
  const relationships: ProposedRelationship[] = [];
  const seen = new Set<string>();
  for (const link of inventory.links) {
    const sourceKey = keyOf.get(link.sourceId);
    const targetKey = keyOf.get(link.targetId);
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;
    const signature = `${sourceKey}>${targetKey}>${link.kind}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    relationships.push({ key: `r${relationships.length + 1}`, sourceKey, targetKey, kind: link.kind, label: link.label.slice(0, 200), decision: "pending", ...(link.protocol ? { protocol: link.protocol.slice(0, 60) } : {}), ...(link.port ? { port: link.port.slice(0, 40) } : {}) });
  }
  const zones = objects.filter((o) => o.typeId === "zone").length;
  const matched = objects.filter((o) => o.componentId).length;
  const notes = [
    `${inventory.format}${inventory.title ? ` (${inventory.title})` : ""}: ${plural(objects.length, "resource")} and ${plural(relationships.length, "relationship")}.`,
    matched ? `${matched} matched to a library component.` : "",
    zones ? `${plural(zones, "network")} drawn as zones around what sits in them.` : "",
    merged ? `${plural(merged, "resource")} with a name and type already in the file merged.` : "",
    "Relationship kinds follow from what each end is; check them before accepting.",
    inventory.skipped.length ? `Also: ${inventory.skipped.join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  if (!objects.length) throw new InventoryError("There is nothing to import.");
  return {
    id: newId("prop"),
    origin: "import",
    importKind: kind,
    source,
    engine: kind === "iac" ? "Infrastructure as code import" : "Discovery import",
    notes,
    createdAt: nowIso(),
    status: "pending",
    targetDiagramId: null,
    objects: objects.map((o) => ({ ...o, matchId: findByName(ws, o.name)?.id ?? null })),
    relationships,
  };
}

/**
 * Infrastructure files from a repository as one inventory. Terraform files of one folder are one
 * configuration, so they are read together; Kubernetes manifests likewise; every other file on
 * its own. Files that are none of the kinds read are listed as left out.
 */
export function readRepositoryFiles(files: { path: string; text: string }[], title: string): Inventory {
  const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const groups = new Map<string, { name: string; text: string[] }>();
  const singles: { path: string; text: string }[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith(".tf") || lower.endsWith(".hcl")) {
      const key = `tf:${folderOf(file.path)}`;
      const g = groups.get(key) ?? { name: `${folderOf(file.path) || "root"}/main.tf`, text: [] };
      g.text.push(file.text);
      groups.set(key, g);
    } else singles.push(file);
  }
  const parts: Inventory[] = [];
  const skipped: string[] = [];
  const read = (name: string, text: string) => {
    try {
      const inventory = readInventory(name, text);
      if (inventory?.items.length) parts.push(inventory);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  };
  for (const g of groups.values()) read(g.name, g.text.join("\n\n"));
  // Manifests are read together so a Service finds the Deployment it selects in another file.
  const yamls = singles.filter((f) => /\.ya?ml$/i.test(f.path));
  const k8s = yamls.filter((f) => /^\s*(apiVersion|kind)\s*:/m.test(f.text) && /^\s*kind\s*:/m.test(f.text) && !/^\s*AWSTemplateFormatVersion|^\s*Resources\s*:/m.test(f.text));
  if (k8s.length) read("manifests.yaml", k8s.map((f) => f.text).join("\n---\n"));
  for (const f of singles.filter((x) => !k8s.includes(x))) read(f.path, f.text);
  if (!parts.length) throw new InventoryError(`No infrastructure as code was found in ${title}.`);
  const items = new Map<string, Inventory["items"][number]>();
  for (const [i, part] of parts.entries()) for (const item of part.items) items.set(items.has(item.id) ? `${i}:${item.id}` : item.id, items.has(item.id) ? { ...item, id: `${i}:${item.id}`, parentId: item.parentId } : item);
  return {
    format: `Infrastructure as code from ${title}`,
    title: parts.map((p) => p.format.replace(/^An? /, "")).filter((v, i, all) => all.indexOf(v) === i).join(", "),
    items: [...items.values()],
    links: parts.flatMap((p) => p.links),
    skipped: [...parts.flatMap((p) => p.skipped), ...(skipped.length ? [`${skipped.length} files that are not infrastructure as code were left out`] : [])],
  };
}
