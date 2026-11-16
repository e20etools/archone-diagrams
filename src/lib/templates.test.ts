import { describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "./catalog";
import { runChecks } from "./checks/checks";
import { CLOUD_SERVICES, cloudService, cloudSuggestions } from "./cloudCatalog";
import { canSetParent, emptyWorkspace } from "./model";
import { TEMPLATES, applyTemplate } from "./templates";
import { RELATION_KINDS } from "./types";

const kinds = new Set(OBJECT_TYPES.map((t) => t.id));

describe("templates", () => {
  it("are each a valid small model: known kinds, nesting the model allows, and ends that exist", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(5);
    for (const t of TEMPLATES) {
      const keys = new Set(t.objects.map((o) => o.key));
      expect(keys.size, t.id).toBe(t.objects.length);
      for (const o of t.objects) {
        expect(kinds.has(o.typeId), `${t.id}: ${o.name}`).toBe(true);
        if (o.inside) expect(keys.has(o.inside), `${t.id}: ${o.name}`).toBe(true);
      }
      for (const [from, to, kind] of t.relationships) {
        expect(keys.has(from) && keys.has(to), `${t.id}: ${from} to ${to}`).toBe(true);
        expect(RELATION_KINDS).toContain(kind);
      }
    }
  });

  it("put the objects, the nesting, the relationships and one laid-out diagram into the model", () => {
    for (const t of TEMPLATES) {
      const made = applyTemplate(emptyWorkspace("T"), t.id)!;
      const objects = Object.values(made.ws.objects);
      expect(made.added, t.id).toBe(t.objects.length);
      expect(objects).toHaveLength(t.objects.length);
      expect(Object.keys(made.ws.relationships), t.id).toHaveLength(t.relationships.length);
      for (const o of t.objects.filter((x) => x.inside)) {
        const child = objects.find((x) => x.name === o.name)!;
        const parent = objects.find((x) => x.name === t.objects.find((p) => p.key === o.inside)!.name)!;
        expect(child.parentId, `${t.id}: ${o.name}`).toBe(parent.id);
        expect(canSetParent(made.ws, child.id, child.typeId, parent.id), `${t.id}: ${o.name}`).toBe(true);
      }
      const diagram = made.ws.diagrams[made.diagramId];
      expect(diagram.name).toBe(t.name);
      const placed = Object.values(diagram.nodes);
      expect(placed).toHaveLength(t.objects.filter((o) => o.typeId !== "system").length);
      // Laid out, not stacked on one spot.
      expect(new Set(placed.map((p) => `${p.x},${p.y}`)).size, t.id).toBe(placed.length);
      // A template does not start life breaking the security rules.
      expect(runChecks(made.ws, null, ["security"]).filter((f) => f.severity === "high"), t.id).toEqual([]);
    }
  });

  it("reuse what the model already has, so using one twice adds a diagram and nothing else", () => {
    const once = applyTemplate(emptyWorkspace("T"), "three-tier")!;
    const twice = applyTemplate(once.ws, "three-tier")!;
    expect(twice).toMatchObject({ added: 0, reused: 7 });
    expect(Object.keys(twice.ws.objects)).toHaveLength(7);
    expect(Object.keys(twice.ws.relationships)).toHaveLength(5);
    expect(Object.values(twice.ws.diagrams).map((d) => d.name).sort()).toEqual(["Three-tier web application", "Three-tier web application 2"]);
    expect(applyTemplate(once.ws, "nope")).toBeNull();
  });
});

describe("the cloud service catalogue", () => {
  it("names each service once, under a kind the model has", () => {
    expect(new Set(CLOUD_SERVICES.map((s) => s.name.toLowerCase())).size).toBe(CLOUD_SERVICES.length);
    for (const s of CLOUD_SERVICES) expect(kinds.has(s.typeId), s.name).toBe(true);
    expect(new Set(CLOUD_SERVICES.map((s) => s.provider))).toEqual(new Set(["AWS", "Azure", "Google Cloud"]));
  });
  it("finds a service however it is typed, and offers the ones of the object's kind first", () => {
    expect(cloudService(" amazon s3 ")).toMatchObject({ provider: "AWS", typeId: "storage" });
    expect(cloudService("PostgreSQL")).toBeUndefined();
    const offered = cloudSuggestions("queue");
    expect(offered).toHaveLength(CLOUD_SERVICES.length);
    const firstOther = offered.findIndex((s) => s.typeId !== "queue");
    expect(firstOther).toBeGreaterThan(5);
    expect(offered.slice(firstOther).every((s) => s.typeId !== "queue")).toBe(true);
  });
});
