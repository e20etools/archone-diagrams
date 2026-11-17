import { describe, expect, it } from "vitest";
import { emptyWorkspace, createObject } from "../model";
import { workspaceSchema, type DecisionTable } from "../types";
import { activitiesInOrder, blankBpmn, buildBpmn, laneName, parseBpmn, BpmnError } from "./bpmn";
import { evaluate, fromDmn, passes, tableFindings, toDmn } from "./dmn";
import { analyseLog, checkConformance, discoverProcess, guessColumns, keepPaths, parseTime, readEventLog, sampleEventLog, LogError } from "./mining";
import { compareModels, createProcess, deleteProcess, ensureProcessObject, pathOf, publishProcess, raciMatrix, restoreVersion, sendForReview, syncProcessLinks, systemsMatrix, updateProcess } from "./processes";
import { baseScenario, rolesOf, simulate } from "./simulate";
import { PROCESS_TEMPLATES, fromTemplate } from "./templates";
import { checkProcess } from "./validate";
import { repairProcess } from "./repair";
import { draftElements, draftProcessFromText, normalizeProcessDraft, reviveProcessDraft } from "./draft";

const simple = () =>
  buildBpmn({
    name: "Approve leave",
    lanes: ["Employee", "Manager"],
    steps: [
      { id: "s", name: "Leave needed", type: "startEvent", lane: "Employee" },
      { id: "ask", name: "Ask for leave", type: "userTask", lane: "Employee" },
      { id: "check", name: "Check the request", type: "userTask", lane: "Manager" },
      { id: "ok", name: "Approved?", type: "exclusiveGateway", lane: "Manager" },
      { id: "book", name: "Book the leave", type: "serviceTask", lane: "Manager" },
      { id: "no", name: "Tell the employee", type: "sendTask", lane: "Manager" },
      { id: "e1", name: "Leave booked", type: "endEvent", lane: "Manager" },
      { id: "e2", name: "Leave refused", type: "endEvent", lane: "Employee" },
    ],
    flows: [
      { from: "s", to: "ask" },
      { from: "ask", to: "check" },
      { from: "check", to: "ok" },
      { from: "ok", to: "book", name: "Yes" },
      { from: "ok", to: "no", name: "No" },
      { from: "book", to: "e1" },
      { from: "no", to: "e2" },
    ],
  });

describe("BPMN files", () => {
  it("writes a process that reads back with its lanes, flows and diagram", () => {
    const xml = simple();
    expect(xml).toContain("<bpmndi:BPMNDiagram");
    expect(xml).toContain('exporter="ArchONE Diagrams"');
    const g = parseBpmn(xml);
    expect(g.processes).toHaveLength(1);
    expect(g.processes[0].participant).toBe("Approve leave");
    expect(g.lanes.map((l) => l.name)).toEqual(["Employee", "Manager"]);
    expect(Object.values(g.flows).filter((f) => f.type === "sequenceFlow")).toHaveLength(7);
    expect(g.nodes.ok.outgoing).toHaveLength(2);
    expect(g.flows.Flow_4.name).toBe("Yes");
    expect(laneName(g, "check")).toBe("Manager");
    expect(activitiesInOrder(g).map((n) => n.name)).toEqual(["Ask for leave", "Check the request", "Book the leave", "Tell the employee"]);
  });

  it("reads a file from another tool, with prefixes, sub-processes and event types", () => {
    const xml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d">
  <process id="P">
    <startEvent id="a"><timerEventDefinition /></startEvent>
    <subProcess id="sub" name="Handle">
      <startEvent id="x" /><task id="t" name="Inner" /><endEvent id="y" />
      <sequenceFlow id="f1" sourceRef="x" targetRef="t" /><sequenceFlow id="f2" sourceRef="t" targetRef="y" />
    </subProcess>
    <endEvent id="b"><terminateEventDefinition /></endEvent>
    <sequenceFlow id="f3" sourceRef="a" targetRef="sub"><conditionExpression>amount &gt; 10</conditionExpression></sequenceFlow>
    <sequenceFlow id="f4" sourceRef="sub" targetRef="b" />
  </process>
</definitions>`;
    const g = parseBpmn(xml);
    expect(g.nodes.a.trigger).toBe("timer");
    expect(g.nodes.b.trigger).toBe("terminate");
    expect(g.nodes.t.name).toBe("Inner");
    expect(g.flows.f3.condition).toContain("amount");
    expect(g.nodes.sub.outgoing).toEqual(["f4"]);
  });

  it("says plainly when a file is not BPMN", () => {
    expect(() => parseBpmn("not xml")).toThrow(BpmnError);
    expect(() => parseBpmn("<svg></svg>")).toThrow(/definitions/);
  });

  it("starts a new process with a start, a step and an end", () => {
    const g = parseBpmn(blankBpmn("New"));
    expect(Object.values(g.nodes).map((n) => n.type).sort()).toEqual(["endEvent", "startEvent", "userTask"]);
  });
});

describe("Checking a model", () => {
  it("passes a well-formed process", () => {
    const findings = checkProcess(parseBpmn(simple()));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("finds the usual modelling mistakes", () => {
    const xml = buildBpmn({
      name: "Messy",
      steps: [
        { id: "s", name: "", type: "startEvent" },
        { id: "a", name: "", type: "task" },
        { id: "b", name: "Lonely", type: "task" },
        { id: "g", name: "", type: "exclusiveGateway" },
        { id: "c", name: "C", type: "task" },
        { id: "d", name: "D", type: "task" },
        { id: "r", name: "Rate", type: "businessRuleTask" },
      ],
      flows: [
        { from: "s", to: "a" },
        { from: "a", to: "g" },
        { from: "g", to: "c" },
        { from: "g", to: "d" },
        { from: "c", to: "r" },
      ],
    });
    const messages = checkProcess(parseBpmn(xml), { elements: {}, decisions: {} }).map((f) => f.message).join("\n");
    expect(messages).toMatch(/no end event/i);
    expect(messages).toMatch(/Nothing leads to "Lonely"/);
    expect(messages).toMatch(/no name/i);
    expect(messages).toMatch(/decision table/i);
  });

  it("flags branch chances that do not add up", () => {
    const g = parseBpmn(simple());
    const findings = checkProcess(g, { elements: { Flow_4: { objectIds: [], raci: {}, probability: 70 }, Flow_5: { objectIds: [], raci: {}, probability: 20 } }, decisions: {} });
    expect(findings.some((f) => /100/.test(f.message))).toBe(true);
  });
});

describe("Simulation", () => {
  it("runs the same scenario to the same answer, and more people shortens the wait", () => {
    const g = parseBpmn(simple());
    const elements = { check: { objectIds: [], raci: {}, duration: { min: 20, mode: 30, max: 60 } }, Flow_4: { objectIds: [], raci: {}, probability: 80 }, Flow_5: { objectIds: [], raci: {}, probability: 20 } };
    const base = { ...baseScenario(g, { elements }), cases: 300, arrivalMinutes: 25 };
    expect(rolesOf(g, { elements })).toEqual(["Employee", "Manager"]);
    const a = simulate(g, { elements }, base);
    const b = simulate(g, { elements }, base);
    expect(a).toEqual(b);
    expect(a.completed).toBe(300);
    expect(a.bottleneck).toBe("Check the request");
    const more = simulate(g, { elements }, { ...base, resources: { ...base.resources, Manager: { count: 3, costPerHour: 50 } } });
    expect(more.meanHours).toBeLessThan(a.meanHours);
    expect(more.costPerCase).toBeGreaterThan(0);
    const booked = a.steps.find((s) => s.id === "book")!.count;
    expect(booked / 300).toBeGreaterThan(0.7);
    expect(booked / 300).toBeLessThan(0.9);
  });

  it("waits for every parallel branch before going on", () => {
    const t = PROCESS_TEMPLATES.find((x) => x.id === "onboarding")!;
    const made = fromTemplate(t);
    const g = parseBpmn(made.xml);
    const r = simulate(g, { elements: made.elements }, { ...baseScenario(g, { elements: made.elements }), cases: 50 });
    expect(r.completed).toBe(50);
    expect(r.steps.find((s) => s.id === "welcome")!.count).toBe(50);
  });

  it("runs every template to the end with no modelling errors", () => {
    for (const t of PROCESS_TEMPLATES) {
      const made = fromTemplate(t);
      const g = parseBpmn(made.xml);
      const errors = checkProcess(g, { elements: made.elements, decisions: {} }).filter((f) => f.severity === "error");
      expect(errors, t.id).toEqual([]);
      const r = simulate(g, { elements: made.elements }, { ...baseScenario(g, { elements: made.elements }), cases: 60 });
      expect(r.completed, t.id).toBe(60);
    }
  });
});

const CSV = `Case ID;Activity;Timestamp;Resource
1;Register;2026-01-05 09:00;Ann
1;Check;2026-01-05 10:00;Bob
1;Approve;2026-01-05 12:00;Bob
2;Register;2026-01-05 09:30;Ann
2;Check;2026-01-05 11:30;Bob
2;Reject;2026-01-05 12:30;Bob
3;Register;2026-01-06 09:00;Ann
3;Check;2026-01-06 09:20;Bob
3;Check;2026-01-06 10:20;Bob
3;Approve;2026-01-06 11:00;Bob
4;Register;2026-01-06 10:00;Ann
4;Check;2026-01-06 11:00;Bob
4;Approve;2026-01-06 15:00;Bob
`;

describe("Process mining", () => {
  it("reads a CSV log, guessing its columns and its separator", () => {
    expect(guessColumns(["Case ID", "Activity", "Timestamp", "Resource"])).toEqual({ caseId: 0, activity: 1, time: 2, resource: 3 });
    const log = readEventLog("claims.csv", CSV);
    expect(log.events).toHaveLength(13);
    expect(log.events[0]).toMatchObject({ caseId: "1", activity: "Register", resource: "Ann" });
  });

  it("reads times in the usual forms", () => {
    expect(parseTime("2026-01-05T09:00:00Z")).toBe(Date.UTC(2026, 0, 5, 9));
    expect(parseTime("05/01/2026 09:00")).toBe(Date.UTC(2026, 0, 5, 9));
    expect(parseTime("1767603600")).toBe(1767603600000);
    expect(Number.isNaN(parseTime("soon"))).toBe(true);
  });

  it("says which columns to pick when it cannot tell", () => {
    expect(() => readEventLog("x.csv", "a,b,c\n1,2,3\n")).toThrow(LogError);
  });

  it("reads XES and OCEL 2.0 logs", () => {
    const xes = `<log xes.version="1.0"><trace><string key="concept:name" value="A1"/>
      <event><string key="concept:name" value="Start"/><date key="time:timestamp" value="2026-01-01T08:00:00Z"/><string key="lifecycle:transition" value="complete"/></event>
      <event><string key="concept:name" value="Start"/><date key="time:timestamp" value="2026-01-01T08:30:00Z"/><string key="lifecycle:transition" value="start"/></event>
      <event><string key="concept:name" value="Finish"/><date key="time:timestamp" value="2026-01-01T09:00:00Z"/><string key="org:resource" value="Kim"/></event>
    </trace></log>`;
    const a = readEventLog("x.xes", xes);
    expect(a.events.map((e) => e.activity)).toEqual(["Start", "Finish"]);
    expect(a.events[1].resource).toBe("Kim");
    const ocel = {
      objectTypes: [{ name: "order" }, { name: "item" }],
      objects: [{ id: "o1", type: "order" }, { id: "i1", type: "item" }, { id: "i2", type: "item" }],
      events: [
        { id: "e1", type: "Place order", time: "2026-01-01T08:00:00Z", relationships: [{ objectId: "o1" }, { objectId: "i1" }, { objectId: "i2" }] },
        { id: "e2", type: "Pick item", time: "2026-01-01T09:00:00Z", relationships: [{ objectId: "i1" }] },
        { id: "e3", type: "Pick item", time: "2026-01-01T09:30:00Z", relationships: [{ objectId: "i2" }] },
      ],
    };
    const b = readEventLog("o.json", JSON.stringify(ocel));
    expect(b.caseType).toBe("item");
    expect(b.events).toHaveLength(4);
    const c = readEventLog("o.json", JSON.stringify(ocel), { caseType: "order" });
    expect(c.events).toHaveLength(1);
  });

  it("finds the paths, variants, times and rework", () => {
    const a = analyseLog(readEventLog("claims.csv", CSV));
    expect(a.cases).toBe(4);
    expect(a.variants[0]).toMatchObject({ steps: ["Register", "Check", "Approve"], count: 2 });
    expect(a.variants).toHaveLength(3);
    expect(a.reworkShare).toBe(0.25);
    expect(a.starts).toEqual({ Register: 4 });
    const t = a.transitions.find((x) => x.from === "Register" && x.to === "Check")!;
    expect(t.count).toBe(4);
    expect(t.medianMinutes).toBe(60);
    expect(a.medianHours).toBe(3);
    expect(keepPaths(a, 0.5).length).toBeGreaterThan(0);
  });

  it("compares the log with a model", () => {
    const model = buildBpmn({
      name: "Claims",
      steps: [
        { id: "s", name: "Start", type: "startEvent" },
        { id: "r", name: "Register", type: "task" },
        { id: "c", name: "Check", type: "task" },
        { id: "g", name: "OK?", type: "exclusiveGateway" },
        { id: "a", name: "Approve", type: "task" },
        { id: "x", name: "Reject", type: "task" },
        { id: "e", name: "End", type: "endEvent" },
        { id: "e2", name: "End 2", type: "endEvent" },
        { id: "u", name: "Archive", type: "task" },
      ],
      flows: [
        { from: "s", to: "r" },
        { from: "r", to: "c" },
        { from: "c", to: "g" },
        { from: "g", to: "a" },
        { from: "g", to: "x" },
        { from: "a", to: "e" },
        { from: "x", to: "e2" },
      ],
    });
    const c = checkConformance(readEventLog("claims.csv", CSV), parseBpmn(model));
    expect(c.conformingCases).toBe(3);
    expect(c.fitness).toBe(0.75);
    expect(c.deviations[0]).toMatchObject({ from: "Check", to: "Check", count: 1 });
    expect(c.unused).toEqual(["Archive"]);
  });

  it("discovers a model that reads back, simulates and fits its own log", () => {
    const log = readEventLog("claims.csv", CSV);
    const analysis = analyseLog(log);
    const { spec, probabilities } = discoverProcess(log, analysis, 0);
    const xml = buildBpmn(spec);
    const g = parseBpmn(xml);
    expect(activitiesInOrder(g).map((n) => n.name).sort()).toEqual(["Approve", "Check", "Register", "Reject"]);
    // Check is followed by Approve three times in five, by Reject once and by itself once.
    expect(Object.values(probabilities).sort((a, b) => a - b)).toEqual([20, 20, 60]);
    expect(checkConformance(log, g).fitness).toBe(1);
    const elements = Object.fromEntries(Object.entries(probabilities).map(([k, p]) => [k, { objectIds: [], raci: {}, probability: p }]));
    expect(simulate(g, { elements }, { ...baseScenario(g, { elements }), cases: 40 }).completed).toBe(40);
  });
});

const table: DecisionTable = {
  id: "risk",
  name: "Loan risk",
  hitPolicy: "FIRST",
  inputs: [
    { id: "score", label: "Credit score", type: "number" },
    { id: "segment", label: "Segment", type: "string" },
  ],
  outputs: [{ id: "decision", label: "Decision", type: "string" }],
  rules: [
    { id: "r1", inputs: ["< 500", "-"], outputs: ['"Decline"'], note: "" },
    { id: "r2", inputs: ["[500..700)", 'not("gold")'], outputs: ['"Refer"'], note: "Borderline" },
    { id: "r3", inputs: ["-", "-"], outputs: ['"Approve"'], note: "" },
  ],
};

describe("The sample log", () => {
  it("draws a connected model at any level of detail", () => {
    const log = readEventLog("p2p.csv", sampleEventLog());
    const analysis = analyseLog(log);
    expect(analysis.cases).toBe(400);
    expect(log.events[0].resource).toBeTruthy();
    for (const share of [0, 0.15, 0.6]) {
      const { spec } = discoverProcess(log, analysis, share);
      const g = parseBpmn(buildBpmn(spec));
      const errors = checkProcess(g).filter((f) => f.severity === "error");
      expect(errors, `share ${share}`).toEqual([]);
      expect(activitiesInOrder(g).map((n) => n.name)).toContain("Reject purchase request");
    }
    expect(discoverProcess(log, analysis, 0).spec.lanes).toEqual(expect.arrayContaining(["Requester", "Manager", "Purchasing", "Accounts payable"]));
  });
});

describe("Decision tables", () => {
  it("applies FEEL unary tests", () => {
    expect(passes("-", 5)).toBe(true);
    expect(passes(">= 18", 18, "number")).toBe(true);
    expect(passes("[1..5]", 5, "number")).toBe(true);
    expect(passes("[1..5)", 5, "number")).toBe(false);
    expect(passes('"gold","silver"', "silver")).toBe(true);
    expect(passes('not("closed")', "open")).toBe(true);
    expect(passes("true", true, "boolean")).toBe(true);
    expect(passes("!= 3", 4, "number")).toBe(true);
  });

  it("answers by the hit policy", () => {
    expect(evaluate(table, { score: "420", segment: "gold" })).toMatchObject({ matched: [0, 2], chosen: [0], outputs: [{ Decision: "Decline" }] });
    expect(evaluate(table, { score: "600", segment: "bronze" }).outputs).toEqual([{ Decision: "Refer" }]);
    expect(evaluate(table, { score: "600", segment: "gold" }).outputs).toEqual([{ Decision: "Approve" }]);
    const unique = evaluate({ ...table, hitPolicy: "UNIQUE" }, { score: "420", segment: "x" });
    expect(unique.problem).toMatch(/only one/);
    const collect = evaluate({ ...table, hitPolicy: "COLLECT" }, { score: "420", segment: "x" });
    expect(collect.outputs).toHaveLength(2);
  });

  it("points out rules worth a look", () => {
    const f = tableFindings({ ...table, rules: [table.rules[2], ...table.rules] });
    expect(f.join(" ")).toMatch(/never used/);
    expect(f.join(" ")).toMatch(/same conditions/);
  });

  it("writes DMN 1.3 that reads back", () => {
    const xml = toDmn(table);
    expect(xml).toContain("https://www.omg.org/spec/DMN/20191111/MODEL/");
    const [back] = fromDmn(xml);
    expect(back.name).toBe("Loan risk");
    expect(back.hitPolicy).toBe("FIRST");
    expect(back.inputs.map((i) => i.type)).toEqual(["number", "string"]);
    expect(back.rules[1].inputs).toEqual(["[500..700)", 'not("gold")']);
    expect(back.rules[1].note).toBe("Borderline");
    expect(evaluate(back, { score: "600", segment: "bronze" }).outputs).toEqual([{ Decision: "Refer" }]);
  });
});

describe("The process repository", () => {
  it("keeps a landscape, versions and links to the model", () => {
    let ws = emptyWorkspace();
    const area = createProcess(ws, { name: "Sales", level: 0, category: "core" });
    ws = area.ws;
    expect(area.process.xml).toBe("");
    const p = createProcess(ws, { name: "Order to cash", parentId: area.process.id, ...fromTemplate(PROCESS_TEMPLATES[0]) });
    ws = p.ws;
    expect(p.process.level).toBe(1);
    expect(pathOf(ws, p.process.id).map((x) => x.name)).toEqual(["Sales", "Order to cash"]);
    // A process cannot sit inside itself.
    ws = updateProcess(ws, area.process.id, { parentId: p.process.id });
    expect(ws.processes[area.process.id].parentId).toBeNull();

    ws = sendForReview(ws, p.process.id, "Dana", "Please check the credit step");
    expect(ws.processes[p.process.id].status).toBe("review");
    ws = publishProcess(ws, p.process.id, "Dana", "First version");
    const first = ws.processes[p.process.id].xml;
    expect(ws.processes[p.process.id]).toMatchObject({ status: "published", version: 1 });
    ws = updateProcess(ws, p.process.id, { xml: blankBpmn("Smaller") });
    const diff = compareModels(first, ws.processes[p.process.id].xml);
    expect(diff.removed).toContain("Ship the goods");
    ws = restoreVersion(ws, p.process.id, 1);
    expect(ws.processes[p.process.id].xml).toBe(first);
    expect(ws.processes[p.process.id].status).toBe("draft");
    for (let i = 0; i < 12; i++) ws = publishProcess(ws, p.process.id, "Dana", `v${i}`);
    expect(ws.processes[p.process.id].versions).toHaveLength(10);
    expect(ws.processes[p.process.id].version).toBe(13);

    const erp = createObject(ws, { typeId: "application", name: "ERP" });
    ws = erp.ws;
    const db = createObject(ws, { typeId: "database", name: "Orders DB" });
    ws = db.ws;
    ws = updateProcess(ws, p.process.id, { elements: { ...ws.processes[p.process.id].elements, invoice: { objectIds: [erp.object.id, db.object.id], raci: { Finance: "R", Sales: "I" } } } });
    const linked = syncProcessLinks(ws, p.process.id);
    expect(linked.added).toBe(2);
    ws = linked.ws;
    const objectId = ws.processes[p.process.id].objectId!;
    expect(ws.objects[objectId].typeId).toBe("process");
    expect(Object.values(ws.relationships).map((r) => r.kind).sort()).toEqual(["depends_on", "reads_writes"]);
    expect(syncProcessLinks(ws, p.process.id).added).toBe(0);
    expect(ensureProcessObject(ws, p.process.id).objectId).toBe(objectId);

    const matrix = systemsMatrix(ws);
    expect(matrix.systems.map((s) => s.name)).toEqual(["ERP", "Orders DB"]);
    expect(matrix.cells[p.process.id][erp.object.id]).toEqual(["Send the invoice"]);
    const raci = raciMatrix(ws.processes[p.process.id]);
    expect(raci.rows.find((r) => r.id === "invoice")!.cells).toEqual({ Finance: "R", Sales: "I" });
    expect(raci.rows.find((r) => r.id === "pick")!.cells).toEqual({ Warehouse: "R" });

    ws = deleteProcess(ws, area.process.id);
    expect(ws.processes[p.process.id].parentId).toBeNull();
    expect(() => workspaceSchema.parse(ws)).not.toThrow();
  });
});

describe("Drafting a process from words", () => {
  it("builds a model from numbered lines, roles and a decision", () => {
    const d = draftProcessFromText(`1. Sales: receive the order
2. Check the credit (Finance)
3. If the credit is approved, ship the goods (Warehouse); otherwise tell the customer and end
4. Send the invoice (Finance)`);
    const g = parseBpmn(buildBpmn(d.spec));
    expect(d.spec.lanes).toEqual(["Sales", "Finance", "Warehouse"]);
    const names = activitiesInOrder(g).map((n) => n.name);
    expect(names).toEqual(["Receive the order", "Check the credit", "Ship the goods", "Tell the customer", "Send the invoice"]);
    expect(Object.values(g.nodes).find((n) => n.name === "The credit is approved?")?.type).toBe("exclusiveGateway");
    expect(Object.values(g.nodes).find((n) => n.name === "Send the invoice")?.type).toBe("sendTask");
    expect(checkProcess(g).filter((f) => f.severity === "error")).toEqual([]);
  });

  it("makes an AI answer hold together", () => {
    const d = normalizeProcessDraft({
      name: "Claims",
      lanes: ["Desk", "Expert"],
      steps: [
        { id: 1, name: "Register the claim", type: "userTask", lane: "Desk", minutes: "10" },
        { id: "g", name: "Simple?", type: "decision", lane: "Desk" },
        { id: "x", name: "Assess the damage", type: "user", lane: "Expert" },
        { id: "p", name: "Pay", type: "serviceTask", lane: "Desk" },
      ],
      flows: [
        { from: 1, to: "g" },
        { from: "g", to: "p", name: "Yes", probability: 70 },
        { from: "g", to: "x", name: "No", probability: 30 },
        { from: "x", to: "p" },
        { from: "x", to: "nowhere" },
      ],
      notes: null,
    })!;
    expect(d.spec.steps[0].type).toBe("startEvent");
    expect(d.spec.steps.at(-1)!.type).toBe("endEvent");
    expect(d.spec.steps.find((s) => s.id === "g")!.type).toBe("exclusiveGateway");
    expect(d.minutes).toEqual({ s_1: 10 });
    const elements = draftElements(d);
    const g = parseBpmn(buildBpmn(d.spec));
    expect(g.flows[Object.keys(elements).find((k) => elements[k].probability === 70)!].name).toBe("Yes");
    expect(simulate(g, { elements }, { ...baseScenario(g, { elements }), cases: 30 }).completed).toBe(30);
    // What the server sends comes back the same.
    expect(reviveProcessDraft(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(reviveProcessDraft({ spec: {} })).toBeNull();
    expect(normalizeProcessDraft({ steps: [] })).toBeNull();
    expect(normalizeProcessDraft("nonsense")).toBeNull();
  });
});

describe("Reading a stored process", () => {
  it("fills what is missing and leaves out only the parts it cannot read", () => {
    const p = repairProcess("proc_1", {
      name: "Order to cash",
      updatedAt: "2026-11-18T00:00:00.000Z",
      elements: { good: { objectIds: ["obj_1"], raci: { Sales: "R" } }, bad: { objectIds: "obj_1" } },
      kpis: [{ id: "k1", name: "Cycle time" }, { id: "k2" }],
      status: "draft",
      level: 9,
    })!;
    expect(p).toMatchObject({ id: "proc_1", name: "Order to cash", createdAt: "2026-11-18T00:00:00.000Z", level: 2, xml: "", versions: [], decisions: {} });
    expect(Object.keys(p.elements)).toEqual(["good"]);
    expect(p.kpis.map((k) => k.id)).toEqual(["k1"]);
    expect(repairProcess("x", "nonsense")).toBeNull();
    expect(repairProcess("x", { name: "" })?.name).toBe("Untitled process");
  });
});
