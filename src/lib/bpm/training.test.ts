import { describe, expect, it } from "vitest";
import { emptyWorkspace } from "../model";
import { parseBpmn } from "./bpmn";
import { BPMN_ELEMENTS } from "./elements";
import { baseScenario, simulate } from "./simulate";
import { TRAINING_EXAMPLES, TRAINING_TAG, addTrainingExamples, fromExample } from "./training";
import { checkProcess } from "./validate";

describe("BPMN training examples", () => {
  it("each opens as BPMN with no modelling errors, and runs to the end in a simulation", () => {
    expect(TRAINING_EXAMPLES).toHaveLength(10);
    for (const t of TRAINING_EXAMPLES) {
      const made = fromExample(t);
      const g = parseBpmn(made.xml);
      const errors = checkProcess(g, { elements: made.elements, decisions: made.decisions }).filter((f) => f.severity === "error");
      expect(errors, t.id).toEqual([]);
      const r = simulate(g, { elements: made.elements }, { ...baseScenario(g, { elements: made.elements }), cases: 40 });
      expect(r.completed, t.id).toBe(40);
      expect(t.lessonAr.length, t.id).toBeGreaterThan(80);
      // Every element an example says it teaches is in the BPMN library.
      for (const id of t.teaches) expect(BPMN_ELEMENTS.some((e) => e.id === id), `${t.id}: ${id}`).toBe(true);
    }
  });

  it("writes boundary events, data, notes, other parties and their messages, with a shape for each", () => {
    const xml = (id: string) => fromExample(TRAINING_EXAMPLES.find((t) => t.id === id)!).xml;
    const deadlines = parseBpmn(xml("purchase-deadlines"));
    const daily = deadlines.nodes.daily;
    expect(daily).toMatchObject({ type: "boundaryEvent", attachedTo: "approve", trigger: "timer" });
    expect(xml("purchase-deadlines")).toContain('attachedToRef="approve" cancelActivity="false"');
    expect(deadlines.nodes.expire.attachedTo).toBe("approve");
    expect(daily.outgoing).toHaveLength(1);

    const supplier = parseBpmn(xml("supplier-messages"));
    const messages = Object.values(supplier.flows).filter((f) => f.type === "messageFlow");
    expect(messages.map((m) => `${m.sourceId}>${m.targetId}`)).toEqual(["send>Partner_supplier", "Partner_supplier>confirmed", "Partner_supplier>goods", "Partner_supplier>invoice", "pay>Partner_supplier"]);
    expect(checkProcess(supplier).filter((f) => f.message.includes("message flow"))).toEqual([]);

    const loan = xml("loan-data");
    const graph = parseBpmn(loan);
    expect(graph.nodes.form).toMatchObject({ type: "dataObjectReference", kind: "data" });
    expect(graph.nodes.bureau).toMatchObject({ type: "dataStoreReference" });
    expect(loan).toContain('<bpmn:dataOutputAssociation id="form_out_1">');
    expect(loan).toContain("<bpmn:sourceRef>bureau</bpmn:sourceRef>");
    expect(Object.values(graph.flows).filter((f) => f.type === "association")).toHaveLength(2);
    // Every element and flow has its place in the diagram.
    for (const x of [xml("purchase-deadlines"), xml("supplier-messages"), loan]) {
      const refs = [...x.matchAll(/bpmnElement="([^"]+)"/g)].map((m) => m[1]);
      for (const id of [...x.matchAll(/<bpmn:(?!definitions|process|collaboration|laneSet|text\b|incoming|outgoing|sourceRef|targetRef|property|dataObject\b)\w+ id="([^"]+)"/g)].map((m) => m[1]).filter((id) => !id.endsWith("_def") && !id.endsWith("_object") && id !== "LaneSet_1")) {
        expect(refs, id).toContain(id);
      }
    }
  });

  it("adds the examples once, under one area, and brings back only those that were removed", () => {
    const first = addTrainingExamples(emptyWorkspace());
    const area = first.ws.processes[first.areaId];
    expect(area).toMatchObject({ level: 0, tags: [TRAINING_TAG] });
    expect(first.added).toHaveLength(10);
    const loan = Object.values(first.ws.processes).find((p) => p.name === "8. Loan application")!;
    expect(loan.decisions.dmn_credit.rules).toHaveLength(2);
    expect(loan.elements.score.decisionId).toBe("dmn_credit");
    expect(loan.description).toContain("What to notice (Data, rules and notes)");
    expect(loan.description).toContain("ما الذي تلاحظه");
    const again = addTrainingExamples(first.ws);
    expect(again.added).toEqual([]);
    expect(again.areaId).toBe(first.areaId);
    const { [loan.id]: _gone, ...rest } = first.ws.processes;
    const back = addTrainingExamples({ ...first.ws, processes: rest });
    expect(back.added).toHaveLength(1);
    expect(back.ws.processes[back.added[0]].name).toBe("8. Loan application");
  });
});
