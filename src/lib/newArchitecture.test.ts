import { describe, expect, it } from "vitest";
import { applyProposal } from "./ai/proposals";
import { componentById, exactComponent } from "./library";
import { archiveDiagram, archivedDiagrams, copyDiagram, createObject, emptyWorkspace, restoreDiagram, sortedDiagrams } from "./model";
import { pageToProposal } from "./import/draft";
import { applyTemplateValue } from "./templates";
import { VIEW_TYPES } from "./types";
import { wizardProblem, wizardSteps, wizardTemplate } from "./wizard";
import { createView } from "./views";

describe("the wizard", () => {
  it("builds, for every kind of diagram, boxes that are all library components and lines between them", () => {
    for (const viewType of VIEW_TYPES) {
      const answers = Object.fromEntries(wizardSteps(viewType).map((s) => [s.id, [{ name: `${s.title} A` }, ...(s.single ? [] : [{ name: `${s.title} B` }])]]));
      expect(wizardProblem(viewType, answers), viewType).toBeNull();
      const t = wizardTemplate(viewType, "Check", answers);
      expect(t.objects.length, viewType).toBeGreaterThan(1);
      for (const o of t.objects) expect(componentById(o.componentId)?.kind, `${viewType} ${o.name}`).toBe(o.typeId);
      expect(t.relationships.length, viewType).toBeGreaterThan(0);
      const { ws, diagramId } = applyTemplateValue(emptyWorkspace("Sara"), t, { name: "Check", viewType });
      expect(ws.diagrams[diagramId].viewType).toBe(viewType);
      expect(Object.values(ws.objects).every((o) => componentById(o.componentId))).toBe(true);
    }
  });

  it("says what is missing, and takes a component chosen or named exactly", () => {
    expect(wizardProblem("container", {})).toMatch(/Which system/);
    const t = wizardTemplate("container", "x", { system: [{ name: "Shop" }], stores: [{ name: "Amazon S3" }, { name: "Orders", componentId: "data.cache" }] });
    expect(t.objects.find((o) => o.name === "Amazon S3")?.componentId).toBe(exactComponent("Amazon S3")?.id);
    expect(t.objects.find((o) => o.name === "Orders")?.componentId).toBe("data.cache");
    // The stores sit inside the system.
    expect(t.objects.find((o) => o.name === "Orders")?.inside).toBe(t.objects.find((o) => o.name === "Shop")?.key);
  });

  it("draws a process as a chain from a start to an end, in BPMN", () => {
    const t = wizardTemplate("business", "x", { process: [{ name: "Order to cash" }], steps: [{ name: "Take order" }, { name: "Ship" }] });
    expect(t.notation).toBe("bpmn");
    expect(t.relationships.filter((r) => r[2] === "flows_to")).toHaveLength(3);
  });
});

describe("copying, archiving and restoring diagrams", () => {
  const model = () => {
    let ws = emptyWorkspace("Sara");
    ws = createObject(ws, { typeId: "service", name: "Billing" }).ws;
    const made = createView(ws, { name: "Billing view", viewType: "custom" });
    const billing = Object.keys(made.ws.objects)[0];
    return { ws: { ...made.ws, diagrams: { ...made.ws.diagrams, [made.diagram.id]: { ...made.diagram, nodes: { [billing]: { x: 0, y: 0, pinned: false } } } } }, id: made.diagram.id, billing };
  };

  it("copies a diagram with the same objects, or with objects of its own", () => {
    const { ws, id, billing } = model();
    const same = copyDiagram(ws, id, { name: "Same", viewType: "container" });
    expect(Object.keys(same.diagram!.nodes)).toEqual([billing]);
    expect(same.diagram!.viewType).toBe("container");
    const separate = copyDiagram(ws, id, { name: "Target", separate: true, label: "target" });
    const [copyId] = Object.keys(separate.diagram!.nodes);
    expect(copyId).not.toBe(billing);
    expect(separate.ws.objects[copyId].name).toBe("Billing (target)");
    expect(separate.ws.diagrams[id].nodes).toEqual(ws.diagrams[id].nodes);
  });

  it("archives and restores only with a reason, and keeps both", () => {
    const { ws, id } = model();
    expect(archiveDiagram(ws, id, "Sara", "  ")).toBe(ws);
    const archived = archiveDiagram(ws, id, "Sara", "Replaced");
    expect(sortedDiagrams(archived).map((d) => d.id)).not.toContain(id);
    expect(archivedDiagrams(archived).map((d) => d.id)).toEqual([id]);
    expect(restoreDiagram(archived, id, "Sara", "")).toBe(archived);
    const back = restoreDiagram(archived, id, "Omar", "Needed again");
    expect(sortedDiagrams(back).map((d) => d.id)).toContain(id);
    expect(back.diagrams[id].archive!.history.map((h) => `${h.action}:${h.by}:${h.reason}`)).toEqual(["archived:Sara:Replaced", "restored:Omar:Needed again"]);
  });
});

describe("a draw.io file matched to the library exactly", () => {
  it("takes the component a label or a stencil names, and leaves the others to be checked", () => {
    const page = {
      name: "Page-1",
      shapes: [
        { id: "a", text: "Amazon S3", x: 0, y: 0, width: 80, height: 60, parentId: null, hint: "" },
        { id: "b", text: "Invoices", x: 200, y: 0, width: 80, height: 60, parentId: null, hint: "shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda" },
        { id: "c", text: "Something odd", x: 400, y: 0, width: 80, height: 60, parentId: null, hint: "rounded=1" },
      ],
      connectors: [{ id: "e", sourceId: "b", targetId: "a", text: "" }],
      skipped: { unlabelled: 0, loose: 0, notes: 0 },
    };
    const proposal = pageToProposal(emptyWorkspace("Sara"), page, "drawio", "x.drawio");
    const byName = Object.fromEntries(proposal.objects.map((o) => [o.name, o]));
    expect(byName["Amazon S3"].componentId).toBe(exactComponent("Amazon S3")!.id);
    expect(byName["Invoices"].componentId).toBe(exactComponent("AWS Lambda")?.id);
    expect(byName["Something odd"].componentId).toBeUndefined();
    expect(proposal.notes).toMatch(/matched no library component exactly/);
    // Accepted as a new diagram of the kind chosen, with its components kept.
    const ws = { ...emptyWorkspace("Sara"), proposals: { [proposal.id]: { ...proposal, diagramName: "From draw.io", diagramViewType: "deployment" as const, objects: proposal.objects.map((o) => ({ ...o, decision: "accepted" as const })), relationships: proposal.relationships.map((r) => ({ ...r, decision: "accepted" as const })) } } };
    const applied = applyProposal(ws, proposal.id, "Sara");
    const diagram = applied.ws.diagrams[applied.diagramId!];
    expect(diagram.name).toBe("From draw.io");
    expect(diagram.viewType).toBe("deployment");
    expect(Object.values(applied.ws.objects).find((o) => o.name === "Amazon S3")?.componentId).toBe(exactComponent("Amazon S3")!.id);
  });
});

describe("the workspace's own wizard steps", () => {
  it("replace the built-in ones for that kind, and connect as set", async () => {
    const { BUILT_IN_STEPS, saveWizard, resetWizard, wizardStepsProblems } = await import("./wizard");
    const steps = [
      ...BUILT_IN_STEPS.deployment,
      { id: "watch", title: "Monitoring", question: "What watches it?", kinds: ["service"], usual: "applications.back-end-service", placeholder: "", links: [{ to: "platforms", kind: "depends_on" as const, label: "Watches", how: "each" as const }] },
    ];
    expect(wizardStepsProblems(steps)).toEqual([]);
    const ws = saveWizard(emptyWorkspace("Sara"), "deployment", steps, "Sara");
    expect(wizardSteps("deployment", ws).map((s) => s.id)).toEqual(["entry", "platforms", "workloads", "watch"]);
    expect(wizardSteps("container", ws)).toBe(BUILT_IN_STEPS.container);
    const t = wizardTemplate("deployment", "x", { platforms: [{ name: "Cluster" }], watch: [{ name: "Zabbix" }] }, ws);
    expect(t.relationships).toContainEqual(["w2", "w1", "depends_on", "Watches"]);
    expect(wizardSteps("deployment", resetWizard(ws, "deployment"))).toBe(BUILT_IN_STEPS.deployment);
  });

  it("say what is wrong before they can be saved", async () => {
    const { wizardStepsProblems } = await import("./wizard");
    expect(wizardStepsProblems([])).toContain("Keep at least one step.");
    const problems = wizardStepsProblems([
      { id: "a", title: "", question: "", kinds: ["database"], usual: "applications.back-end-service", placeholder: "", inside: "gone", links: [{ to: "nowhere", kind: "calls", label: "", how: "each" }] },
    ]);
    expect(problems.join(" ")).toMatch(/needs a title/);
    expect(problems.join(" ")).toMatch(/not one of the kinds/);
    expect(problems.join(" ")).toMatch(/sit inside no longer exists/);
    expect(problems.join(" ")).toMatch(/connection points to a step/);
  });
});
