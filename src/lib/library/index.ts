import { isKnownType, objectType } from "../catalog";
import type { ModelObject } from "../types";
import { CLOUD_NAMES, PROVIDERS, cloudLook, type Provider } from "./cloud";
import { GENERIC_SECTIONS } from "./generic";
import { profileById, type Profile } from "./profiles";

/**
 * The component library: everything an architecture can be drawn with, in sections. A
 * component is a named kind of thing (a firewall, a data warehouse, Amazon S3) on top of one
 * of the model's object types. Placing one creates an ordinary object of that type that
 * remembers which component it is, so it is drawn with the component's icon and asks for the
 * component's basic information.
 */

export interface LibrarySection {
  id: string;
  label: string;
  hint: string;
  icon: string;
  color: string;
  /** Set for a cloud provider's section. */
  provider?: string;
  /** For a provider: the group the section belongs to, as the provider files it. */
  group: string;
}

export interface LibraryComponent {
  id: string;
  name: string;
  sectionId: string;
  kind: string;
  icon: string;
  profile: string;
  provider?: string;
  /** Other names to find it by. */
  aliases: string;
}

/** A name as it is compared: case, spaces and punctuation do not make two components different. */
export const normalizeComponentName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function build() {
  const sections: LibrarySection[] = [];
  const components: LibraryComponent[] = [];
  for (const s of GENERIC_SECTIONS) {
    sections.push({ id: s.id, label: s.label, hint: s.hint, icon: s.icon, color: s.color, group: "General" });
    for (const [name, icon, kind, profile, aliases] of s.items) {
      components.push({ id: `${s.id}.${slug(name)}`, name, sectionId: s.id, kind: kind ?? s.kind, icon, profile: profile ?? s.profile, aliases: aliases ?? "" });
    }
  }
  for (const provider of PROVIDERS) {
    for (const [group, names] of CLOUD_NAMES[provider.id] ?? []) {
      const sectionId = `${provider.id}.${slug(group)}`;
      sections.push({ id: sectionId, label: `${provider.short}: ${group}`, hint: `${provider.label} services filed under ${group}`, icon: cloudLook(group, "").icon, color: provider.color, provider: provider.id, group });
      for (const name of names) {
        const look = cloudLook(group, name);
        components.push({ id: `${provider.id}.${slug(name)}`, name, sectionId, kind: look.kind, icon: look.icon, profile: look.profile, provider: provider.id, aliases: `${provider.short} ${provider.label}` });
      }
    }
  }
  return { sections, components };
}

const built = build();
export const LIBRARY_SECTIONS: LibrarySection[] = built.sections;
export const LIBRARY: LibraryComponent[] = built.components;
export { PROVIDERS, type Provider };

const BY_ID = new Map(LIBRARY.map((c) => [c.id, c]));
const SECTION_BY_ID = new Map(LIBRARY_SECTIONS.map((s) => [s.id, s]));
export const componentById = (id: string | undefined | null) => (id ? BY_ID.get(id) : undefined);
export const sectionById = (id: string) => SECTION_BY_ID.get(id);
export const providerById = (id: string | undefined) => (id ? PROVIDERS.find((p) => p.id === id) : undefined);
export const componentsIn = (sectionId: string) => LIBRARY.filter((c) => c.sectionId === sectionId);

/** The name to show with a component: "Amazon S3" stays itself, a cloud service gets its provider. */
export const componentLabel = (c: LibraryComponent) => {
  const provider = providerById(c.provider);
  return provider ? `${provider.short} ${c.name}` : c.name;
};

/**
 * The second line under an object's name. A box named after its component would say the same
 * thing twice, so it says where the component comes from instead: "Security", "AWS".
 */
export function componentSubtitle(o: Pick<ModelObject, "componentId" | "name">): string | null {
  const c = componentById(o.componentId);
  if (!c) return null;
  if (normalizeComponentName(o.name) !== normalizeComponentName(c.name)) return c.name;
  return providerById(c.provider)?.short ?? sectionById(c.sectionId)?.label ?? c.name;
}

/** The component an object was made from, if it still exists in the library. */
export const componentOf = (o: Pick<ModelObject, "componentId">) => componentById(o.componentId);

/** The basic information an object asks for: its component's, or else a sensible one for its type. */
export function profileOf(o: Pick<ModelObject, "componentId" | "typeId">): Profile {
  const component = componentOf(o);
  if (component) return profileById(component.profile);
  return profileById(TYPE_PROFILE[o.typeId] ?? "generic");
}

const TYPE_PROFILE: Record<string, string> = {
  domain: "capability",
  actor: "organisation",
  system: "application",
  "external-system": "external",
  application: "application",
  "web-app": "application",
  "mobile-app": "application",
  service: "application",
  database: "database",
  queue: "messaging",
  cache: "database",
  storage: "storage",
  gateway: "network-device",
  server: "server",
  cluster: "kubernetes",
  network: "network-device",
  component: "generic",
  "ai-agent": "ai",
  "ai-model": "ai",
  "mcp-server": "ai",
  process: "process",
  task: "process",
  event: "process",
  decision: "process",
};

/** Components whose name, other names, section or provider contain every word typed. Best matches first. */
export function searchLibrary(query: string, options: { sectionId?: string; provider?: string | null; limit?: number } = {}): LibraryComponent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = LIBRARY.filter((c) => (!options.sectionId || c.sectionId === options.sectionId) && (options.provider === undefined || (options.provider === null ? !c.provider : c.provider === options.provider)));
  if (!words.length) return pool.slice(0, options.limit ?? pool.length);
  const scored: { c: LibraryComponent; score: number }[] = [];
  for (const c of pool) {
    const name = c.name.toLowerCase();
    const section = SECTION_BY_ID.get(c.sectionId)?.label.toLowerCase() ?? "";
    const hay = `${name} ${c.aliases.toLowerCase()} ${section} ${objectType(c.kind).label.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const whole = words.join(" ");
    // A name's own short form, "(S3)" or "(OKE)", counts as much as the name itself.
    const short = /\(([^)]+)\)\s*$/.exec(name)?.[1] ?? "";
    const score = (name === whole || short === whole ? 0 : name.startsWith(whole) ? 1 : name.includes(whole) ? 2 : words.every((w) => name.includes(w)) ? 3 : 4) * 1000 + name.length;
    scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, options.limit ?? scored.length).map((s) => s.c);
}

const EXACT = (() => {
  const map = new Map<string, LibraryComponent[]>();
  const add = (key: string, c: LibraryComponent) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(c)) list.push(c);
    map.set(key, list);
  };
  for (const c of LIBRARY) {
    add(normalizeComponentName(c.name), c);
    const short = /\(([^)]+)\)\s*$/.exec(c.name)?.[1];
    if (short) add(normalizeComponentName(short), c);
    for (const alias of c.aliases.split(/[,;]/)) add(normalizeComponentName(alias), c);
    // A cloud service is also called by its provider's name in front: "Amazon S3", "AWS Lambda", "Azure Functions".
    const provider = c.provider ? PROVIDERS.find((p) => p.id === c.provider) : undefined;
    if (provider) {
      const prefixes = new Set([provider.short, provider.label, provider.label.split(" ")[0]]);
      for (const prefix of prefixes) {
        add(normalizeComponentName(`${prefix} ${c.name}`), c);
        if (short) add(normalizeComponentName(`${prefix} ${short}`), c);
      }
    }
  }
  return map;
})();

/**
 * The one library component a name stands for exactly: its name, its short form or one of its
 * other names, ignoring case and punctuation. Nothing when no component, or more than one, fits.
 * A kind narrows the choice when several fit.
 */
export function exactComponent(text: string, kind?: string): LibraryComponent | undefined {
  const found = EXACT.get(normalizeComponentName(text)) ?? [];
  const fitting = kind ? found.filter((c) => c.kind === kind) : found;
  if (fitting.length === 1) return fitting[0];
  // A general component wins over the same name at a cloud provider.
  const general = fitting.filter((c) => !c.provider);
  return general.length === 1 ? general[0] : undefined;
}

/** What placing a component writes into a new object. */
export function objectFromComponent(c: LibraryComponent): { typeId: string; name: string; componentId: string; technology: string } {
  return { typeId: isKnownType(c.kind) ? c.kind : "application", name: c.name, componentId: c.id, technology: c.provider ? componentLabel(c) : "" };
}

export const LIBRARY_COUNTS = {
  components: LIBRARY.length,
  sections: LIBRARY_SECTIONS.length,
  general: LIBRARY.filter((c) => !c.provider).length,
  cloud: LIBRARY.filter((c) => !!c.provider).length,
};
