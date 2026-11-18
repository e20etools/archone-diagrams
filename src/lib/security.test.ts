import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo";
import { findByName } from "./model";
import { classificationOf, findingsByObject, protectionOf, trustOfZone } from "./security";
import type { Relationship } from "./types";

const rel = (patch: Partial<Relationship>): Relationship => ({
  id: "r",
  sourceId: "a",
  targetId: "b",
  kind: "calls",
  label: "",
  protocol: "",
  port: "",
  description: "",
  provenance: { origin: "manual" },
  createdAt: "",
  updatedAt: "",
  ...patch,
}) as Relationship;

describe("the security view", () => {
  it("calls a connection encrypted, not encrypted or not recorded from what the model holds", () => {
    expect(protectionOf(rel({ protocols: [{ name: "HTTPS", port: "443" }] }))).toBe("encrypted");
    expect(protectionOf(rel({ protocols: [{ name: "HTTP", port: "80" }] }))).toBe("plain");
    expect(protectionOf(rel({ protocols: [{ name: "HTTP", port: "80" }], encrypted: "yes" }))).toBe("encrypted");
    expect(protectionOf(rel({ protocols: [{ name: "HTTPS", port: "443" }], encrypted: "no" }))).toBe("plain");
    expect(protectionOf(rel({}))).toBe("unknown");
    // A protocol that may or may not be encrypted is not guessed.
    expect(protectionOf(rel({ protocols: [{ name: "Kafka", port: "9092" }] }))).toBe("unknown");
    expect(protectionOf(rel({ protocol: "ssh", port: "22" }))).toBe("encrypted");
  });

  it("reads how far a zone is trusted from its name", () => {
    expect(trustOfZone("Internet")).toBe("untrusted");
    expect(trustOfZone("DMZ")).toBe("perimeter");
    expect(trustOfZone("Internal network")).toBe("internal");
    expect(trustOfZone("PCI zone")).toBe("restricted");
    expect(trustOfZone("Riyadh site")).toBeNull();
  });

  it("counts findings per box and reads how a box's data is classified", () => {
    const counts = findingsByObject([
      { ruleId: "x", severity: "high", message: "", objectIds: ["a", "b"] },
      { ruleId: "y", severity: "medium", message: "", objectIds: ["a", "a"] },
    ] as never);
    expect(counts).toEqual({ a: { high: 1, medium: 1, low: 0 }, b: { high: 1, medium: 0, low: 0 } });
    const ws = demoWorkspace("Khaled");
    const db = findByName(ws, "Orders database")!;
    expect(classificationOf({ ...db, fields: { "Data classification": "confidential" } })).toBe("Confidential");
    expect(classificationOf({ ...db, fields: { "Personal data": "Yes" }, tags: [] })).toBe("Personal data");
    expect(classificationOf({ ...db, fields: { "Data classification": "Internal" }, tags: [] })).toBeNull();
  });
});
