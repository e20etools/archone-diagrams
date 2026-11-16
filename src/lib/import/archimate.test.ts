import { describe, expect, it } from "vitest";
import { demoWorkspace } from "../demo";
import { emptyWorkspace, findByName } from "../model";
import { isArchimate, readArchimate, writeArchimate } from "./archimate";
import { guessMapping, sheetsToProposal } from "./draft";
import { descendants, parseXml } from "./xml";

const ws = demoWorkspace();
const xml = writeArchimate(ws);

describe("ArchiMate export", () => {
  it("writes a well-formed exchange file with every object, relationship and diagram", () => {
    expect(isArchimate(xml)).toBe(true);
    const root = parseXml(xml);
    expect(root.attrs.xmlns).toBe("http://www.opengroup.org/xsd/archimate/3.0/");
    expect(descendants(root, "element")).toHaveLength(22);
    const relationships = descendants(root, "relationship");
    expect(relationships.filter((r) => ["Serving", "Flow"].includes(r.attrs.type))).toHaveLength(25);
    expect(descendants(root, "view")).toHaveLength(3);
    // Every reference points at something that exists.
    const ids = new Set(descendants(root, "element").map((e) => e.attrs.identifier));
    expect(relationships.every((r) => ids.has(r.attrs.source) && ids.has(r.attrs.target))).toBe(true);
    const nodes = descendants(root, "node");
    expect(nodes.length).toBeGreaterThan(10);
    expect(nodes.every((n) => ids.has(n.attrs.elementRef) && Number.isFinite(Number(n.attrs.x)))).toBe(true);
    const nodeIds = new Set(nodes.map((n) => n.attrs.identifier));
    const relIds = new Set(relationships.map((r) => r.attrs.identifier));
    expect(descendants(root, "connection").every((c) => nodeIds.has(c.attrs.source) && nodeIds.has(c.attrs.target) && relIds.has(c.attrs.relationshipRef))).toBe(true);
    const defs = new Set(descendants(root, "propertyDefinition").map((d) => d.attrs.identifier));
    expect(descendants(root, "property").every((p) => defs.has(p.attrs.propertyDefinitionRef))).toBe(true);
  });
  it("says 'B serves A' for 'A calls B', and uses composition only where ArchiMate allows it", () => {
    const root = parseXml(xml);
    const id = (name: string) => `id-${findByName(ws, name)!.id}`;
    const serving = descendants(root, "relationship").find((r) => r.attrs.type === "Serving" && r.attrs.source === id("Orders database") && r.attrs.target === id("Order service"));
    expect(serving).toBeTruthy();
    const inside = (child: string) => descendants(root, "relationship").find((r) => r.attrs.target === id(child) && ["Composition", "Association"].includes(r.attrs.type) && r.attrs.identifier.startsWith("id-in-"))!;
    expect(inside("Online store").attrs.type).toBe("Composition"); // a grouping holds anything
    expect(inside("Order service").attrs.type).toBe("Composition"); // application component in application component
    expect(inside("Orders database").attrs.type).toBe("Association"); // system software in an application component
  });
  it("escapes text that would break the file", () => {
    const odd = demoWorkspace();
    const first = Object.values(odd.objects)[0];
    first.name = 'R&D <"core">';
    first.fields = { "Cost & centre": "<42>" };
    const again = readArchimate(writeArchimate(odd));
    expect(again[0].rows.some((r) => r[0] === 'R&D <"core">')).toBe(true);
  });
});

describe("ArchiMate import", () => {
  it("brings back a file written here exactly: types, owners, nesting, kinds and direction", () => {
    const sheets = readArchimate(xml);
    const { proposal, report } = sheetsToProposal(emptyWorkspace(), sheets, sheets.map(guessMapping), "model.xml");
    expect(report.skipped).toEqual([]);
    expect(proposal.objects).toHaveLength(22);
    expect(proposal.relationships).toHaveLength(25);
    const byName = Object.fromEntries(proposal.objects.map((o) => [o.name, o]));
    for (const o of Object.values(ws.objects)) {
      const got = byName[o.name];
      expect([got.typeId, got.owner ?? "", got.technology, (got.tags ?? []).join()], o.name).toEqual([o.typeId, o.owner, o.technology, o.tags.join()]);
      expect(got.parentKey ? proposal.objects.find((p) => p.key === got.parentKey)!.name : null, o.name).toBe(o.parentId ? ws.objects[o.parentId].name : null);
    }
    const key = (name: string) => byName[name].key;
    const link = proposal.relationships.find((r) => r.sourceKey === key("Order service") && r.targetKey === key("Orders database"))!;
    expect(link.kind).toBe("reads_writes");
    expect(byName["Session cache"].lifecycle).toBe("deprecated");
  });
  it("reads a file from another tool, mapping elements and relationships to the nearest thing here", () => {
    const foreign = `<?xml version="1.0"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m">
 <name xml:lang="en">From Archi</name>
 <elements>
  <element identifier="a" xsi:type="BusinessActor"><name xml:lang="en">Clerk</name></element>
  <element identifier="b" xsi:type="ApplicationComponent"><name xml:lang="en">Claims app</name><documentation xml:lang="en">Handles claims</documentation></element>
  <element identifier="c" xsi:type="DataObject"><name xml:lang="en">Claims data</name></element>
  <element identifier="d" xsi:type="Node"><name xml:lang="en">App server</name></element>
  <element identifier="g" xsi:type="Grouping"><name xml:lang="en">Claims</name></element>
  <element identifier="x" xsi:type="Goal"><name xml:lang="en">Faster claims</name></element>
  <element identifier="n" xsi:type="Node"></element>
 </elements>
 <relationships>
  <relationship identifier="r1" source="b" target="a" xsi:type="Serving"/>
  <relationship identifier="r2" source="b" target="c" xsi:type="Access"><name xml:lang="en">writes</name></relationship>
  <relationship identifier="r3" source="d" target="b" xsi:type="Assignment"/>
  <relationship identifier="r4" source="g" target="b" xsi:type="Aggregation"/>
  <relationship identifier="r5" source="b" target="missing" xsi:type="Flow"/>
 </relationships>
</model>`;
    const sheets = readArchimate(foreign);
    const objects = Object.fromEntries(sheets[0].rows.slice(1).map((r) => [r[0], r]));
    expect(Object.keys(objects)).toEqual(["Clerk", "Claims app", "Claims data", "App server", "Claims", "Faster claims"]);
    expect([objects.Clerk[1], objects["Claims data"][1], objects["App server"][1], objects.Claims[1], objects["Faster claims"][1]]).toEqual(["Person or team", "Database", "Server or VM", "Domain", "Application"]);
    expect(objects["Claims app"][7]).toBe("Claims");
    expect(sheets[1].rows.slice(1).map((r) => r.slice(0, 4).join(" | "))).toEqual(["Clerk | Claims app | Depends on | ", "Claims app | Claims data | Depends on | writes", "Claims app | App server | Depends on | "]);
  });
  it("explains a file that is not an exchange file", () => {
    expect(() => readArchimate("<mxfile/>")).toThrow(/not an ArchiMate exchange file/);
    expect(() => readArchimate('<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/"><elements/></model>')).toThrow(/no elements/);
    expect(isArchimate("<mxfile><diagram/></mxfile>")).toBe(false);
  });
});
