import { processModelSchema, type ProcessModel } from "../types";

/**
 * A process as stored, made safe for the app. Rows come from the app itself, from the API and
 * from older versions of the app, so a field may be missing or of the wrong shape: missing
 * fields take their defaults, and a part that cannot be read (one step's details, one KPI) is
 * left out rather than the whole process.
 */
export function repairProcess(id: string, raw: unknown): ProcessModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = new Date().toISOString();
  const data = structuredClone(raw) as Record<string, unknown>;
  data.id = id;
  if (typeof data.name !== "string" || !data.name.trim()) data.name = "Untitled process";
  if (typeof data.createdAt !== "string") data.createdAt = typeof data.updatedAt === "string" ? data.updatedAt : now;
  if (typeof data.updatedAt !== "string") data.updatedAt = data.createdAt;
  for (let round = 0; round < 25; round++) {
    const parsed = processModelSchema.safeParse(data);
    if (parsed.success) return parsed.data;
    const drop: (string | number)[][] = parsed.error.issues.map((i) => i.path.slice(0, 2));
    if (drop.some((p) => !p.length || ["id", "name", "createdAt", "updatedAt"].includes(String(p[0])) && p.length === 1)) return null;
    const lists = new Map<string, Set<number>>();
    for (const [top, inner] of drop) {
      const key = String(top);
      const value = data[key];
      if (inner === undefined || value === null || typeof value !== "object") delete data[key];
      else if (Array.isArray(value)) lists.set(key, (lists.get(key) ?? new Set()).add(Number(inner)));
      else delete (value as Record<string, unknown>)[String(inner)];
    }
    for (const [key, gone] of lists) data[key] = (data[key] as unknown[]).filter((_, i) => !gone.has(i));
  }
  return null;
}
