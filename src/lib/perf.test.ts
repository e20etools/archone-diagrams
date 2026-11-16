import { describe, expect, it } from "vitest";
import { runChecks } from "./checks/checks";
import { createRule, emptySelector } from "./checks/custom";
import { compareTables } from "./cloud/collab";
import { diffTables, toTables } from "./cloud/tables";
import { impactOf } from "./graph";
import { createObject, createRelationship, emptyWorkspace, updateObject } from "./model";
import type { Workspace } from "./types";
import { createView, visibleEdges } from "./views";

/**
 * How the parts that run on every edit hold up on a large model. The limits are loose on
 * purpose: they are there to catch something becoming many times slower, not to rank machines.
 * Measured on the build machine: see "Large models" in the README.
 */

/** Domains of systems of services, each service with a database, and calls that mostly stay inside a system. */
export function bigModel(objects: number): Workspace {
  let ws = emptyWorkspace("Large");
  const add = (name: string, typeId: string, parentId: string | null = null, tags: string[] = []) => {
    const made = createObject(ws, { name, typeId, parentId, owner: `Team ${name.length % 7}`, tags });
    ws = made.ws;
    return made.object.id;
  };
  const leaves: string[] = [];
  let n = 0;
  for (let d = 0; n < objects; d++) {
    const domain = add(`Domain ${d}`, "domain");
    n += 1;
    for (let s = 0; s < 5 && n < objects; s++) {
      const system = add(`System ${d}.${s}`, "system", domain);
      n += 1;
      for (let c = 0; c < 9 && n < objects; c++) {
        leaves.push(add(`${c % 3 === 0 ? "Store" : "Service"} ${d}.${s}.${c}`, c % 3 === 0 ? "database" : "service", system, c % 4 === 0 ? ["pci"] : []));
        n += 1;
      }
    }
  }
  // About two relationships per object: a chain inside the system and a longer hop.
  for (let i = 0; i + 1 < leaves.length; i++) {
    ws = createRelationship(ws, { sourceId: leaves[i], targetId: leaves[i + 1], kind: "calls", protocol: i % 5 ? "HTTPS" : "HTTP" }).ws;
    if (i + 17 < leaves.length) ws = createRelationship(ws, { sourceId: leaves[i], targetId: leaves[i + 17], kind: "depends_on" }).ws;
  }
  return ws;
}

const time = <T>(run: () => T): [T, number] => {
  const started = performance.now();
  const out = run();
  return [out, performance.now() - started];
};

describe("a large model", () => {
  for (const [size, limit] of [[500, 400], [2000, 1500], [5000, 5000]] as const) {
    it(`of ${size} objects is checked, compared and walked within ${limit} ms each`, () => {
      const ws = bigModel(size);
      const relationships = Object.keys(ws.relationships).length;
      expect(Object.keys(ws.objects).length).toBe(size);
      expect(relationships).toBeGreaterThan(size);

      const withRule = createRule(ws, { title: "", text: "", severity: "high", check: { kind: "journey", from: { ...emptySelector(), types: ["service"] }, to: { ...emptySelector(), types: ["database"] }, through: { ...emptySelector(), tags: ["pci"] }, mode: "never" } }).ws;
      const timings: Record<string, number> = {};
      let findings: unknown[];
      [findings, timings.checks] = time(() => runChecks(ws, null, ["practice", "security", "privacy", "pci", "nca", "ai"]));
      [, timings.journey] = time(() => runChecks(withRule, null, []));
      const first = Object.values(ws.objects).find((o) => o.typeId === "service")!;
      const edited = updateObject(ws, first.id, { description: "Changed" });
      [, timings.edit] = time(() => createObject(updateObject(ws, first.id, { owner: "Someone else" }), { name: "One more", typeId: "service" }));
      [, timings.save] = time(() => diffTables(toTables(ws), toTables(edited)));
      [, timings.compare] = time(() => compareTables(toTables(ws), toTables(edited)));
      [, timings.impact] = time(() => impactOf(ws, first.id, "retiring"));
      const landscape = createView(ws, { name: "All domains", viewType: "landscape", scopeId: null });
      [, timings.arrows] = time(() => visibleEdges(landscape.ws, landscape.diagram));

      process.stderr.write(`${size} objects, ${relationships} relationships: ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(", ")}\n`);
      expect(findings.length).toBeGreaterThan(0);
      for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(limit);
    }, 180_000);
  }
});
