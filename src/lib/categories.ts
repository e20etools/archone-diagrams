import { OBJECT_TYPES } from "./catalog";
import type { Role } from "./cloud/backend";
import type { ViewType, Workspace } from "./types";

/**
 * The five categories a diagram belongs to, and the roles a member can have in each. These rules
 * mirror the database's (migration phase4_category_roles), which is where they are enforced; here
 * they decide what the screens offer and refuse an edit before it is sent.
 */
export const CATEGORIES = ["applications", "data", "infrastructure", "business", "custom"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_INFO: Record<Category, { label: string; hint: string }> = {
  applications: { label: "Applications", hint: "Systems, applications and how they connect, as C4 views" },
  data: { label: "Data", hint: "Where data lives and which applications read or write it" },
  infrastructure: { label: "Infrastructure", hint: "Servers, clusters, networks and what is hosted on them" },
  business: { label: "Business", hint: "Domains, processes and the people who take part" },
  custom: { label: "Custom", hint: "Any objects you choose" },
};

export const CATEGORY_ROLES = ["editor", "commenter", "viewer", "none"] as const;
export type CategoryRole = (typeof CATEGORY_ROLES)[number];
export type CategoryRoles = Partial<Record<Category, CategoryRole>>;

export const CATEGORY_ROLE_LABEL: Record<CategoryRole, string> = { editor: "Edit", commenter: "Comment", viewer: "View", none: "No access" };

/** The kinds of diagram in each category, in the order they are offered. */
export const VIEWS_BY_CATEGORY: Record<Category, ViewType[]> = {
  applications: ["landscape", "context", "container"],
  data: ["dataflow"],
  infrastructure: ["deployment"],
  business: ["business"],
  custom: ["custom"],
};

export function viewCategory(viewType: ViewType): Category {
  return (Object.entries(VIEWS_BY_CATEGORY).find(([, views]) => views.includes(viewType))?.[0] as Category) ?? "custom";
}

/** The categories an object of this type belongs to. People and domains belong to two. */
export function typeCategories(typeId: string): Category[] {
  if (typeId === "domain" || typeId === "actor") return ["applications", "business"];
  // A box standing for another diagram belongs to no category: the workspace role decides.
  if (typeId === "diagram") return [];
  const category = OBJECT_TYPES.find((t) => t.id === typeId)?.category;
  switch (category) {
    case "application":
    case "external":
      return ["applications"];
    case "data":
      return ["data"];
    case "infrastructure":
      return ["infrastructure"];
    case "business":
    case "people":
      return ["business"];
    default:
      return [];
  }
}

const RANK: Record<string, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1, none: 0 };

/**
 * What a member may do in a category: 0 nothing, 1 view, 2 comment, 3 edit, 4 own. A category
 * narrows the workspace role, never widens it. No role (browser-only mode) means everything.
 */
export function categoryRank(role: Role | null, roles: CategoryRoles | null | undefined, category: Category | string): number {
  if (role === null) return 4;
  if (role === "owner") return 4;
  const own = roles?.[category as Category];
  return Math.min(RANK[role] ?? 0, own ? RANK[own] : RANK[role] ?? 0);
}

export const canEditCategories = (role: Role | null, roles: CategoryRoles | null | undefined, categories: Category[]) =>
  categories.length === 0 || categories.some((c) => categoryRank(role, roles, c) >= 3);

/** The categories this member cannot see at all. */
export const hiddenCategories = (role: Role | null, roles: CategoryRoles | null | undefined) => CATEGORIES.filter((c) => categoryRank(role, roles, c) === 0);

/** True when the member has any role per category that differs from the workspace role. */
export const narrowed = (role: Role | null, roles: CategoryRoles | null | undefined) => CATEGORIES.some((c) => categoryRank(role, roles, c) < (role ? RANK[role] : 4));

const same = (a: object | undefined, b: object | undefined) => JSON.stringify({ ...a, updatedAt: "" }) === JSON.stringify({ ...b, updatedAt: "" });

/**
 * Why a change cannot be saved by this member, or null when it can. Mirrors the database: a
 * diagram needs edit in its category (before and after), an object in one of its categories, a
 * relationship at one of its ends, a saved template in its perspective.
 */
type Model = Pick<Workspace, "objects" | "relationships" | "diagrams" | "templates">;
export function categoryRefusal(before: Model, after: Model, role: Role | null, roles: CategoryRoles | null | undefined): string | null {
  if (!narrowed(role, roles)) return null;
  const can = (category: Category) => categoryRank(role, roles, category) >= 3;
  const refuse = (category: Category) => `You can view ${CATEGORY_INFO[category].label} but not change it. Ask an owner if this needs changing.`;
  if (before.diagrams !== after.diagrams) {
    for (const id of new Set([...Object.keys(before.diagrams), ...Object.keys(after.diagrams)])) {
      const [was, is] = [before.diagrams[id], after.diagrams[id]];
      if (was === is || (was && is && same(was, is))) continue;
      for (const d of [was, is]) if (d && !can(viewCategory(d.viewType))) return refuse(viewCategory(d.viewType));
    }
  }
  const objectOk = (ws: Model, id: string) => {
    const o = ws.objects[id];
    return !o || canEditCategories(role, roles, typeCategories(o.typeId));
  };
  if (before.objects !== after.objects) {
    for (const id of new Set([...Object.keys(before.objects), ...Object.keys(after.objects)])) {
      const [was, is] = [before.objects[id], after.objects[id]];
      if (was === is || (was && is && same(was, is))) continue;
      for (const o of [was, is]) {
        if (o && !canEditCategories(role, roles, typeCategories(o.typeId))) return refuse(typeCategories(o.typeId)[0]);
      }
    }
  }
  if (before.relationships !== after.relationships) {
    for (const id of new Set([...Object.keys(before.relationships), ...Object.keys(after.relationships)])) {
      const [was, is] = [before.relationships[id], after.relationships[id]];
      if (was === is || (was && is && same(was, is))) continue;
      if (was && !objectOk(before, was.sourceId) && !objectOk(before, was.targetId)) return "You cannot change a relationship between objects outside the categories you edit.";
      if (is && !objectOk(after, is.sourceId) && !objectOk(after, is.targetId)) return "You cannot change a relationship between objects outside the categories you edit.";
    }
  }
  if (before.templates !== after.templates) {
    for (const id of new Set([...Object.keys(before.templates ?? {}), ...Object.keys(after.templates ?? {})])) {
      const [was, is] = [before.templates?.[id], after.templates?.[id]];
      if (was === is) continue;
      for (const t of [was, is]) if (t && !can(t.perspective)) return refuse(t.perspective);
    }
  }
  return null;
}
