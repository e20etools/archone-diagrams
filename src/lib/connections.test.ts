import { describe, expect, it } from "vitest";
import { runChecks } from "./checks/checks";
import { diagramPicture, pictureSvg } from "./export/picture";
import { PROTOCOLS, protocolByName, protocolLabel, searchProtocols } from "./library/protocols";
import { createDiagram, createObject, createRelationship, emptyWorkspace, protocolsOf, setProtocols, updateRelationship } from "./model";
import { addObjectsToDiagram } from "./views";

const model = () => {
  let ws = emptyWorkspace("Sara");
  const app = createObject(ws, { typeId: "service", name: "Billing" });
  ws = app.ws;
  const dir = createObject(ws, { typeId: "service", name: "Directory" });
  ws = dir.ws;
  const r = createRelationship(ws, { sourceId: app.object.id, targetId: dir.object.id, kind: "calls" });
  return { ws: r.ws, id: r.relationship!.id, app: app.object.id, dir: dir.object.id };
};

describe("connections: direction and protocols", () => {
  it("has a catalogue of protocols and ports without repeats", () => {
    expect(PROTOCOLS.length).toBeGreaterThan(140);
    expect(new Set(PROTOCOLS.map((p) => `${p.name}|${p.port}`)).size).toBe(PROTOCOLS.length);
    expect(protocolByName("ldaps")).toMatchObject({ port: "636", secure: true });
    expect(searchProtocols("1433")[0].name).toBe("Microsoft SQL Server");
    expect(protocolLabel({ name: "HTTPS", port: "443", transport: "TCP" })).toBe("HTTPS 443/TCP");
  });

  it("keeps one or more protocols, and the plain fields follow", () => {
    let { ws, id } = model();
    ws = setProtocols(ws, id, [{ name: "LDAPS", port: "636", transport: "TCP" }, { name: "Kerberos", port: "88" }, { name: "ldaps", port: "636" }]);
    expect(protocolsOf(ws.relationships[id]).map((p) => p.name)).toEqual(["LDAPS", "Kerberos"]);
    expect(ws.relationships[id]).toMatchObject({ protocol: "LDAPS, Kerberos", port: "636, 88" });
    ws = setProtocols(ws, id, []);
    expect(ws.relationships[id].protocols).toBeUndefined();
    expect(ws.relationships[id].protocol).toBe("");
  });

  it("goes out, in or both ways, and is drawn that way", () => {
    let { ws, id, app, dir } = model();
    ws = updateRelationship(ws, id, { flow: "both", network: "MPLS", encrypted: "yes" });
    expect(ws.relationships[id]).toMatchObject({ flow: "both", network: "MPLS", encrypted: "yes" });
    const d = createDiagram(ws, { name: "x", viewType: "custom" });
    ws = addObjectsToDiagram(d.ws, d.diagram.id, [app, dir]);
    const svg = pictureSvg(diagramPicture(ws, ws.diagrams[d.diagram.id]));
    expect(svg).toContain("marker-start");
    expect(svg).toContain("marker-end");
    ws = updateRelationship(ws, id, { flow: undefined });
    expect(ws.relationships[id].flow).toBeUndefined();
  });

  it("points out clear-text protocols unless the connection is encrypted", () => {
    let { ws, id } = model();
    ws = setProtocols(ws, id, [{ name: "HTTP", port: "80" }, { name: "PostgreSQL", port: "5432" }]);
    const found = runChecks(ws, null, ["security"]).filter((f) => f.ruleId === "clear-text");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("uses HTTP,");
    ws = updateRelationship(ws, id, { encrypted: "yes" });
    expect(runChecks(ws, null, ["security"]).filter((f) => f.ruleId === "clear-text")).toHaveLength(0);
  });
});
