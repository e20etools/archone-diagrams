import { describe, expect, it } from "vitest";
import { diagramMap, mapReach } from "./diagramMap";
import { SAMPLE_DIAGRAMS, SAMPLE_TAG, addEnterpriseSample } from "./enterpriseSample";
import { whatIf } from "./impact";
import { diagramsUsing, emptyWorkspace, protocolsOf } from "./model";
import { runChecks } from "./checks/checks";

describe("the enterprise sample", () => {
  const { ws, diagrams } = addEnterpriseSample(emptyWorkspace("Bank"));
  const byName = (name: string) => Object.values(ws.diagrams).find((d) => d.name === name)!;

  it("adds ten diagrams, each with enough on it to be worth analysing", () => {
    expect(diagrams).toHaveLength(10);
    expect(Object.values(ws.diagrams).map((d) => d.name).sort()).toEqual([...SAMPLE_DIAGRAMS].sort());
    for (const d of Object.values(ws.diagrams)) expect(Object.keys(d.nodes).length, d.name).toBeGreaterThanOrEqual(9);
    expect(Object.values(ws.objects).every((o) => o.tags.includes(SAMPLE_TAG))).toBe(true);
  });

  it("is added once", () => {
    const again = addEnterpriseSample(ws);
    expect(again.added).toBe(false);
    expect(again.ws).toBe(ws);
  });

  it("shares components between diagrams and carries protocols on the connections", () => {
    const ad = Object.values(ws.objects).find((o) => o.name === "Active Directory")!;
    expect(diagramsUsing(ws, ad.id).length).toBeGreaterThanOrEqual(5);
    expect(ad.componentId).toBeTruthy();
    const withProtocols = Object.values(ws.relationships).filter((r) => protocolsOf(r).length);
    expect(withProtocols.length).toBeGreaterThan(80);
    expect(Object.values(ws.relationships).every((r) => ws.objects[r.sourceId] && ws.objects[r.targetId])).toBe(true);
    expect(Object.values(ws.objects).filter((o) => o.typeId === "diagram").length).toBeGreaterThanOrEqual(3);
  });

  it("links the diagrams on the map, and an outage travels across them", () => {
    const map = diagramMap(ws);
    expect(map.links.filter((l) => l.kind === "depends").length).toBeGreaterThanOrEqual(15);
    expect(map.links.filter((l) => l.kind === "shared").length).toBeGreaterThanOrEqual(15);
    expect(mapReach(map, byName("Identity and access").id, "neededBy").size).toBeGreaterThanOrEqual(5);
    const ad = Object.values(ws.objects).find((o) => o.name === "Active Directory")!;
    const outage = whatIf(ws, [{ kind: "object", id: ad.id }]);
    expect(outage.affected.length).toBeGreaterThan(15);
    expect(outage.diagrams.length).toBeGreaterThanOrEqual(6);
    expect(outage.impact).toBe(5);
    const network = whatIf(ws, [{ kind: "diagram", id: byName("Data centre network").id }]);
    expect(network.diagrams.length).toBeGreaterThanOrEqual(5);
  });

  it("draws zones around what sits in them on the network diagram", async () => {
    const { zonesOf } = await import("./zones");
    const zones = zonesOf(ws, byName("Data centre network"));
    expect(zones.map((z) => z.name)).toEqual(expect.arrayContaining(["DMZ", "Internal LAN", "Database zone", "PCI zone", "DR site"]));
  });

  it("leaves a few things for the checks to find, on purpose", () => {
    const findings = runChecks(ws, null, ["security", "practice", "pci", "nca"]);
    // Data stores without a classification, and card systems to scope, are left for the reader to fix.
    expect(findings.some((f) => f.ruleId === "classification-missing")).toBe(true);
    expect(findings.some((f) => f.ruleId === "pci-scope")).toBe(true);
    expect(findings.filter((f) => f.severity === "high")).toEqual([]);
  });
});
