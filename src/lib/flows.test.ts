import { describe, expect, it } from "vitest";
import { compareTables } from "./cloud/collab";
import { toTables } from "./cloud/tables";
import { addFlow, addStep, deleteFlow, deleteStep, flowsOf, moveStep, stepLine, stepRoute, stepView, updateFlow, updateStep, MAX_FLOWS, MAX_STEPS } from "./flows";
import { cleanLinks, linkHost, linkLabel, safeUrl } from "./links";
import { createDiagram, createObject, createRelationship, deleteObject, emptyWorkspace, placeNodes, removeNodes, updateObject, updateRelationship } from "./model";
import { buildSharePayload } from "./share";
import { redactForTrust } from "./trust";
import type { Workspace } from "./types";
import { workspaceSchema } from "./types";

/** A shop: the web app calls the API, the API writes to the database, and a mail service sits beside them. */
function shop() {
  let ws: Workspace = emptyWorkspace("Shop");
  const make = (name: string, typeId: string) => {
    const made = createObject(ws, { name, typeId });
    ws = made.ws;
    return made.object.id;
  };
  const web = make("Web", "web-app");
  const api = make("API", "service");
  const store = make("Orders", "database");
  const mail = make("Mail", "service");
  const off = make("Not drawn", "service");
  const link = (sourceId: string, targetId: string) => {
    const made = createRelationship(ws, { sourceId, targetId, kind: "calls" });
    ws = made.ws;
    return made.relationship!.id;
  };
  const webApi = link(web, api);
  const apiStore = link(api, store);
  const made = createDiagram(ws, { name: "Checkout" });
  ws = placeNodes(made.ws, made.diagram.id, Object.fromEntries([web, api, store, mail].map((id, i) => [id, { x: i * 300, y: 0, pinned: false }])));
  return { ws, d: made.diagram.id, web, api, store, mail, off, webApi, apiStore };
}

describe("flows", () => {
  it("tell a use case as steps between the boxes of one diagram", () => {
    const s = shop();
    const made = addFlow(s.ws, s.d, "  A customer pays  ");
    let ws = made.ws;
    const flow = made.flow!;
    expect(flow).toMatchObject({ name: "A customer pays", steps: [] });
    ws = addStep(ws, s.d, flow.id, s.web, s.api, " sends the basket ").ws;
    ws = addStep(ws, s.d, flow.id, s.api, s.store, "saves the order").ws;
    // The answer travels against the arrow, and a step can stay inside one box.
    ws = addStep(ws, s.d, flow.id, s.api, s.web, "confirms").ws;
    ws = addStep(ws, s.d, flow.id, s.api, s.api, "works out the tax").ws;
    const steps = flowsOf(ws.diagrams[s.d])[0].steps;
    expect(steps.map((x) => x.text)).toEqual(["sends the basket", "saves the order", "confirms", "works out the tax"]);
    expect(stepRoute(ws, steps[0])).toBe("Web to API");
    expect(stepRoute(ws, steps[3])).toBe("Inside API");
    expect(stepLine(ws, steps[1], 1)).toBe("2. API to Orders: saves the order");

    const diagram = ws.diagrams[s.d];
    expect(stepView(ws, diagram, steps[0])).toEqual({ nodes: [s.web, s.api], edges: [s.webApi], missing: false });
    // A reply lights the same arrow it came in on.
    expect(stepView(ws, diagram, steps[2])).toEqual({ nodes: [s.api, s.web], edges: [s.webApi], missing: false });
    expect(stepView(ws, diagram, steps[3])).toEqual({ nodes: [s.api], edges: [], missing: false });
    // Nothing in the model changed: a flow is a way of reading the diagram.
    expect(ws.objects).toBe(s.ws.objects);
    expect(ws.relationships).toBe(s.ws.relationships);
    expect(workspaceSchema.safeParse(ws).success).toBe(true);
  });

  it("only accept boxes that are on the diagram, and keep within their limits", () => {
    const s = shop();
    const { ws: started, flow } = addFlow(s.ws, s.d, "");
    expect(flow!.name).toBe("Flow 1");
    expect(addStep(started, s.d, flow!.id, s.web, s.off)).toEqual({ ws: started, step: null });
    expect(addStep(started, s.d, "no such flow", s.web, s.api).step).toBeNull();
    expect(addFlow(started, "no such diagram", "x").flow).toBeNull();

    let ws = started;
    for (let i = 0; i < MAX_STEPS + 5; i++) ws = addStep(ws, s.d, flow!.id, s.web, s.api, `step ${i}`).ws;
    expect(flowsOf(ws.diagrams[s.d])[0].steps).toHaveLength(MAX_STEPS);
    for (let i = 0; i < MAX_FLOWS + 5; i++) ws = addFlow(ws, s.d, `Flow ${i}`).ws;
    expect(flowsOf(ws.diagrams[s.d])).toHaveLength(MAX_FLOWS);
    const long = addStep(started, s.d, flow!.id, s.web, s.api, "x".repeat(900)).step!;
    expect(long.text).toHaveLength(400);
  });

  it("can be renamed, reordered, edited and deleted", () => {
    const s = shop();
    const made = addFlow(s.ws, s.d, "Pay");
    const f = made.flow!.id;
    let ws = made.ws;
    for (const text of ["one", "two", "three"]) ws = addStep(ws, s.d, f, s.web, s.api, text).ws;
    const ids = () => flowsOf(ws.diagrams[s.d])[0].steps.map((x) => x.text);
    const [a, , c] = flowsOf(ws.diagrams[s.d])[0].steps;
    ws = moveStep(ws, s.d, f, c.id, -1);
    expect(ids()).toEqual(["one", "three", "two"]);
    ws = moveStep(ws, s.d, f, a.id, -1);
    expect(ids()).toEqual(["one", "three", "two"]);
    ws = updateStep(ws, s.d, f, a.id, { toId: s.store, text: "first" });
    ws = updateStep(ws, s.d, f, a.id, { fromId: s.off });
    expect(flowsOf(ws.diagrams[s.d])[0].steps[0]).toMatchObject({ fromId: s.web, toId: s.store, text: "first" });
    ws = deleteStep(ws, s.d, f, a.id);
    expect(ids()).toEqual(["three", "two"]);
    ws = updateFlow(ws, s.d, f, { name: "  ", description: " How paying works " });
    expect(flowsOf(ws.diagrams[s.d])[0]).toMatchObject({ name: "Pay", description: "How paying works" });
    ws = deleteFlow(ws, s.d, f);
    // The last flow gone leaves no empty list behind, so the diagram is as it was before it had flows.
    expect("flows" in ws.diagrams[s.d]).toBe(false);
  });

  it("lose the steps of a deleted object, and say so when a box is only taken off the diagram", () => {
    const s = shop();
    const made = addFlow(s.ws, s.d, "Pay");
    const f = made.flow!.id;
    let ws = addStep(made.ws, s.d, f, s.web, s.api, "asks").ws;
    ws = addStep(ws, s.d, f, s.api, s.store, "saves").ws;
    ws = addStep(ws, s.d, f, s.api, s.mail, "mails").ws;

    const taken = removeNodes(ws, s.d, [s.mail]);
    const kept = flowsOf(taken.diagrams[s.d])[0].steps;
    expect(kept).toHaveLength(3);
    expect(stepView(taken, taken.diagrams[s.d], kept[2])).toEqual({ nodes: [s.api], edges: [], missing: true });

    const gone = deleteObject(ws, s.store);
    expect(flowsOf(gone.diagrams[s.d])[0].steps.map((x) => x.text)).toEqual(["asks", "mails"]);
    // A diagram the object never touched is left as the same object.
    const other = createDiagram(ws, { name: "Other" });
    expect(deleteObject(other.ws, s.store).diagrams[other.diagram.id]).toBe(other.ws.diagrams[other.diagram.id]);
  });

  it("show up when two versions are compared, and stay off the public trust page", () => {
    const s = shop();
    const made = addFlow(s.ws, s.d, "Pay");
    const ws = addStep(made.ws, s.d, made.flow!.id, s.web, s.api, "asks").ws;
    const changes = compareTables(toTables(s.ws), toTables(ws)).diagrams.changed;
    expect(changes).toHaveLength(1);
    expect(changes[0].fields).toEqual([{ field: "Flows", before: "nothing", after: "Pay (1 step: asks)" }]);
    const cut = redactForTrust(toTables(ws), s.d);
    expect("flows" in cut.diagrams[s.d]).toBe(false);
    expect(JSON.stringify(cut)).not.toMatch(/asks/);
  });
});

describe("links to the real thing", () => {
  it("accept web addresses only", () => {
    expect(safeUrl("https://github.com/team/billing")).toBe("https://github.com/team/billing");
    expect(safeUrl("  github.com/team/billing ")).toBe("https://github.com/team/billing");
    expect(safeUrl("http://localhost:3000/docs")).toBe("http://localhost:3000/docs");
    for (const bad of ["", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "ftp://files.example.com", "vbscript:x", "billing", "https://", "two words.com", "https://user:secret@example.com/x", `https://example.com/${"x".repeat(2100)}`]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
    expect(linkHost("https://www.grafana.example.com/d/1")).toBe("grafana.example.com");
    expect(linkLabel({ label: " ", url: "https://github.com/team/billing" })).toBe("github.com");
    expect(linkLabel({ label: "Runbook", url: "https://wiki.example.com" })).toBe("Runbook");
  });

  it("are cleaned on the way into the model", () => {
    const links = cleanLinks([
      { label: "  Repo ", url: "github.com/team/billing" },
      { label: "Again", url: "https://github.com/team/billing" },
      { label: "Bad", url: "javascript:alert(1)" },
      { label: "x".repeat(200), url: "https://wiki.example.com/runbook" },
    ]);
    expect(links).toEqual([
      { label: "Repo", url: "https://github.com/team/billing" },
      { label: "x".repeat(80), url: "https://wiki.example.com/runbook" },
    ]);
    expect(cleanLinks(Array.from({ length: 40 }, (_, i) => ({ label: "", url: `https://example.com/${i}` })))).toHaveLength(20);
  });

  it("sit on objects and connections, and an empty list is no list", () => {
    const s = shop();
    let ws = updateObject(s.ws, s.api, { links: [{ label: "Repo", url: "github.com/team/api" }, { label: "", url: "javascript:alert(1)" }] });
    expect(ws.objects[s.api].links).toEqual([{ label: "Repo", url: "https://github.com/team/api" }]);
    ws = updateObject(ws, s.api, { owner: "Payments" });
    expect(ws.objects[s.api].links).toHaveLength(1);
    ws = updateObject(ws, s.api, { links: [] });
    expect("links" in ws.objects[s.api]).toBe(false);

    ws = updateRelationship(ws, s.webApi, { links: [{ label: "API contract", url: "https://example.com/openapi.json" }] });
    expect(ws.relationships[s.webApi].links).toEqual([{ label: "API contract", url: "https://example.com/openapi.json" }]);
    expect(workspaceSchema.safeParse(ws).success).toBe(true);
    const fields = compareTables(toTables(s.ws), toTables(ws)).relationships.changed[0].fields;
    expect(fields).toEqual([{ field: "Links", before: "nothing", after: "API contract (https://example.com/openapi.json)" }]);
  });

  it("do not withdraw a confirmed dependency, because a link is not what was confirmed", () => {
    const s = shop();
    const confirmed: Workspace = { ...s.ws, relationships: { ...s.ws.relationships, [s.webApi]: { ...s.ws.relationships[s.webApi], acknowledgement: { by: "Ann", at: "2026-11-16T09:00:00.000Z" } } } };
    expect(updateRelationship(confirmed, s.webApi, { links: [{ label: "", url: "https://example.com" }] }).relationships[s.webApi].acknowledgement).toBeDefined();
    expect(updateRelationship(confirmed, s.webApi, { label: "asks" }).relationships[s.webApi].acknowledgement).toBeUndefined();
  });

  it("stay out of a snapshot link, which anyone holding it can open", () => {
    const s = shop();
    let ws = updateObject(s.ws, s.api, { links: [{ label: "Repo", url: "https://github.com/team/api" }] });
    ws = updateRelationship(ws, s.webApi, { links: [{ label: "Contract", url: "https://example.com/openapi.json" }] });
    const payload = buildSharePayload(ws, ws.diagrams[s.d]);
    expect(JSON.stringify(payload)).not.toMatch(/github\.com|openapi/);
    expect(payload.objects.find((o) => o.id === s.api)).toMatchObject({ name: "API" });
  });
});
