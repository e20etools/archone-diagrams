import { describe, expect, it } from "vitest";
import { diagramPicture } from "./export/picture";
import { LIBRARY, componentsIn, exactComponent } from "./library";
import { addObjectsToDiagram } from "./views";
import { createDiagram, createObject, diagramBox, emptyWorkspace } from "./model";
import { zonesOf } from "./zones";

describe("network zones, connections, integrations and diagram boxes", () => {
  it("are new library sections, each without repeats", () => {
    for (const [section, at_least] of [["zones", 50], ["connections", 50], ["integrations", 110], ["diagrams", 1]] as const) {
      const items = componentsIn(section);
      expect(items.length, section).toBeGreaterThanOrEqual(at_least);
      expect(new Set(items.map((c) => c.name.toLowerCase())).size, section).toBe(items.length);
    }
    expect(exactComponent("DMZ")?.kind).toBe("zone");
    expect(exactComponent("MPLS")?.sectionId).toBe("connections");
    expect(exactComponent("GSN")?.sectionId).toBe("connections");
    for (const name of ["Active Directory", "DNS", "DHCP", "SIEM", "Backup", "SMTP relay"]) expect(exactComponent(name), name).toBeTruthy();
    expect(LIBRARY.filter((c) => c.kind === "zone").every((c) => c.sectionId === "zones")).toBe(true);
  });

  it("draw a zone around what sits in it, and nest zones", () => {
    let ws = emptyWorkspace("Sara");
    const dmz = createObject(ws, { typeId: "zone", name: "DMZ", componentId: "zones.dmz" });
    ws = dmz.ws;
    const web = createObject(ws, { typeId: "server", name: "Web server", parentId: dmz.object.id });
    ws = web.ws;
    const lonely = createObject(ws, { typeId: "zone", name: "Empty zone" });
    ws = lonely.ws;
    const d = createDiagram(ws, { name: "Net", viewType: "deployment" });
    ws = addObjectsToDiagram(d.ws, d.diagram.id, [dmz.object.id, web.object.id, lonely.object.id]);
    const zones = zonesOf(ws, ws.diagrams[d.diagram.id]);
    expect(zones.map((z) => z.name)).toEqual(["DMZ"]);
    expect(zones[0].members).toEqual([web.object.id]);
    expect(zones[0].color).toBe("#E08A1E");
    const p = diagramPicture(ws, ws.diagrams[d.diagram.id]);
    expect(p.zones.map((z) => z.label)).toEqual(["DMZ"]);
    // The zone with nothing in it stays a box; the one around the server is not a box.
    expect(p.nodes.map((n) => n.name).sort()).toEqual(["Empty zone", "Web server"]);
  });

  it("make one box per diagram, reused wherever that diagram is connected to", () => {
    let ws = emptyWorkspace("Sara");
    const target = createDiagram(ws, { name: "Payments", viewType: "container" });
    ws = target.ws;
    const first = diagramBox(ws, target.diagram.id);
    const again = diagramBox(first.ws, target.diagram.id);
    expect(again.objectId).toBe(first.objectId);
    const box = first.ws.objects[first.objectId!];
    expect(box).toMatchObject({ typeId: "diagram", name: "Payments", diagramId: target.diagram.id, componentId: "diagrams.diagram" });
    expect(diagramBox(ws, "missing").objectId).toBeNull();
  });
});
