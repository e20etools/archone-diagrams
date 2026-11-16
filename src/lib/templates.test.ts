import { describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "./catalog";
import { runChecks } from "./checks/checks";
import { CLOUD_SERVICES, cloudService, cloudSuggestions } from "./cloudCatalog";
import { canSetParent, emptyWorkspace } from "./model";
import { componentById, normalizeComponentName } from "./library";
import { templatePreview } from "./templatePreview";
import { PERSPECTIVES, TEMPLATES, applyTemplate, containers, searchTemplates, templatesIn } from "./templates";
import { RELATION_KINDS } from "./types";

const kinds = new Set(OBJECT_TYPES.map((t) => t.id));

describe("templates", () => {
  it("are each a valid small model: known kinds, nesting the model allows, and ends that exist", () => {
    expect(TEMPLATES.length).toBe(115);
    for (const p of PERSPECTIVES) expect(templatesIn(p.id).length, p.id).toBeGreaterThanOrEqual(20);
    const ids = TEMPLATES.map((t) => t.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const names = TEMPLATES.map((t) => normalizeComponentName(t.name));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    for (const t of TEMPLATES) {
      const keys = new Set(t.objects.map((o) => o.key));
      expect(keys.size, t.id).toBe(t.objects.length);
      expect(t.objects.length, t.id).toBeGreaterThanOrEqual(5);
      expect(t.objects.length, t.id).toBeLessThanOrEqual(12);
      const objectNames = t.objects.map((o) => o.name.toLowerCase());
      expect(objectNames.filter((n, i) => objectNames.indexOf(n) !== i), t.id).toEqual([]);
      for (const o of t.objects) {
        expect(kinds.has(o.typeId), `${t.id}: ${o.name}`).toBe(true);
        expect(o.name.trim(), `${t.id}: ${o.key}`).not.toBe("");
        // Only what the library has: every box is a library component, and of the component's type.
        const component = componentById(o.componentId);
        expect(component, `${t.id}: ${o.name} (${o.componentId})`).toBeDefined();
        expect(o.typeId, `${t.id}: ${o.name}`).toBe(component!.kind);
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
      expect(placed).toHaveLength(t.objects.length - containers(t).size);
      if (t.notation) expect(diagram.notation, t.id).toBe(t.notation);
      if (t.direction) expect(diagram.direction, t.id).toBe(t.direction);
      // Laid out, not stacked on one spot.
      expect(new Set(placed.map((p) => `${p.x},${p.y}`)).size, t.id).toBe(placed.length);
      // A template does not start life breaking the security rules.
      expect(runChecks(made.ws, null, ["security"]).filter((f) => f.severity === "high"), t.id).toEqual([]);
    }
  });

  it("draw library components with their icons and ask for their information", () => {
    const made = applyTemplate(emptyWorkspace("T"), "dmz")!;
    const waf = Object.values(made.ws.objects).find((o) => o.name === "WAF")!;
    expect(waf).toMatchObject({ componentId: "security.web-application-firewall", typeId: "gateway" });
    // Every box of every template, the first five included, comes from the library.
    expect(TEMPLATES.flatMap((t) => t.objects).filter((o) => !componentById(o.componentId))).toEqual([]);
    for (const t of TEMPLATES) {
      const made = applyTemplate(emptyWorkspace("T"), t.id)!;
      expect(Object.values(made.ws.objects).filter((o) => !componentById(o.componentId)).map((o) => o.name), t.id).toEqual([]);
    }
  });

  it("are found by words and by perspective", () => {
    expect(searchTemplates("kyc").map((t) => t.id)).toContain("customer-onboarding");
    expect(searchTemplates("dmz").map((t) => t.id)).toContain("dmz");
    expect(searchTemplates("zatca").map((t) => t.id)).toContain("e-invoicing");
    expect(searchTemplates("firewall", "business")).toEqual([]);
    expect(searchTemplates("smart building").map((t) => t.id)).toContain("smart-building");
    expect(searchTemplates("", "data")).toEqual(templatesIn("data"));
  });

  it("each have a small preview with every box in its place and no two boxes on one spot", () => {
    for (const t of TEMPLATES) {
      const p = templatePreview(t);
      expect(p.boxes.length, t.id).toBe(t.objects.length - containers(t).size);
      expect(new Set(p.boxes.map((b) => `${b.x},${b.y}`)).size, t.id).toBe(p.boxes.length);
      expect(p.width > 0 && p.height > 0, t.id).toBe(true);
      expect(templatePreview(t)).toBe(p);
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

describe("templates made from a diagram", () => {
  const start = () => applyTemplate(emptyWorkspace("Sara"), TEMPLATES.find((t) => t.perspective === "applications")!.id)!;

  it("keeps every box as a library component, the lines between them, and where they stand", async () => {
    const { templateFromDiagram, saveTemplate, allTemplates } = await import("./templates");
    const { ws, diagramId } = start();
    const diagram = ws.diagrams[diagramId];
    const made = templateFromDiagram(ws, diagramId, { name: "Our shop", perspective: "business", about: "Mine" }, "Sara")!;
    expect(made.template.perspective).toBe("business");
    expect(made.template.objects.length).toBe(Object.keys(diagram.nodes).length);
    for (const o of made.template.objects) {
      expect(componentById(o.componentId)).toBeTruthy();
      expect(o.typeId).toBe(componentById(o.componentId)!.kind);
    }
    expect(Math.min(...made.template.objects.map((o) => o.x))).toBe(0);
    expect(made.template.relationships.length).toBeGreaterThan(0);
    const saved = saveTemplate(ws, made.template);
    expect(allTemplates(saved)[0].id).toBe(made.template.id);
    expect(allTemplates(saved)[0].saved?.author).toBe("Sara");
  });

  it("makes a box outside the library the usual component for its type, and says so", async () => {
    const { templateFromDiagram } = await import("./templates");
    const { ws, diagramId } = start();
    const first = Object.keys(ws.diagrams[diagramId].nodes)[0];
    const loose = { ...ws, objects: { ...ws.objects, [first]: { ...ws.objects[first], componentId: undefined } } };
    const made = templateFromDiagram(loose, diagramId, { name: "x", perspective: "applications", about: "" }, "Sara")!;
    expect(made.substitutions.map((s) => s.objectId)).toEqual([first]);
    expect(componentById(made.substitutions[0].componentId)).toBeTruthy();
  });

  it("uses a saved template with its boxes where they were, and can delete it", async () => {
    const { templateFromDiagram, saveTemplate, deleteSavedTemplate } = await import("./templates");
    const { ws, diagramId } = start();
    const made = templateFromDiagram(ws, diagramId, { name: "Again", perspective: "data", about: "" }, "Sara")!;
    const saved = saveTemplate(ws, made.template);
    const used = applyTemplate(saved, made.template.id)!;
    const nodes = Object.values(used.ws.diagrams[used.diagramId].nodes);
    expect(nodes.length).toBe(made.template.objects.length);
    const xs = nodes.map((n) => n.x).sort((a, b) => a - b);
    expect(xs).toEqual(made.template.objects.map((o) => o.x).sort((a, b) => a - b));
    expect(deleteSavedTemplate(saved, made.template.id).templates).toEqual({});
  });

  it("every type has a usual library component", async () => {
    const { USUAL_COMPONENT } = await import("./templates");
    for (const t of OBJECT_TYPES) {
      const id = USUAL_COMPONENT[t.id];
      if (id) expect(componentById(id), t.id).toBeTruthy();
    }
  });
});
