import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_LIBRARY, LIBRARY, applyLibraryItems, componentById, componentsIn, exactComponent, searchLibrary } from "./library";
import { BUILT_IN_PROTOCOLS, PROTOCOLS, applyProtocolItems, protocolByName } from "./library/protocols";
import {
  componentUsers,
  duplicateComponent,
  duplicateProtocol,
  protocolUsers,
  removeComponent,
  removeProtocol,
  removedComponents,
  removedProtocols,
  renameOnConnections,
  resetComponent,
  resetProtocol,
  saveComponent,
  saveProtocol,
} from "./libraryEdits";
import { createObject, createRelationship, emptyWorkspace, setProtocols } from "./model";
import type { Workspace } from "./types";

const use = (ws: Workspace) => {
  applyLibraryItems(ws.library);
  applyProtocolItems(ws.library);
  return ws;
};

afterEach(() => {
  applyLibraryItems({});
  applyProtocolItems({});
});

describe("a workspace's own components", () => {
  it("adds a new one to its section, found by id, name and search", () => {
    const made = saveComponent(emptyWorkspace("Sara"), { name: "Core ledger", sectionId: "applications", kind: "application", icon: "Landmark", profile: "application", aliases: "general ledger GL" });
    use(made.ws);
    const c = componentById(made.id)!;
    expect(c).toMatchObject({ name: "Core ledger", sectionId: "applications", custom: true });
    expect(componentsIn("applications").at(-1)?.id).toBe(made.id);
    expect(exactComponent("core ledger")?.id).toBe(made.id);
    expect(searchLibrary("ledger").map((c) => c.id)).toContain(made.id);
    expect(LIBRARY.length).toBe(BUILT_IN_LIBRARY.length + 1);
  });

  it("changes a built-in one under its own id, and goes back to it", () => {
    const firewall = BUILT_IN_LIBRARY.find((c) => c.name === "Next-generation firewall")!;
    let ws = saveComponent(emptyWorkspace("Sara"), { name: "Palo Alto firewall", sectionId: firewall.sectionId, kind: firewall.kind, icon: "Flame", profile: firewall.profile, aliases: "" }, firewall.id).ws;
    use(ws);
    expect(componentById(firewall.id)).toMatchObject({ name: "Palo Alto firewall", icon: "Flame", changed: true });
    expect(LIBRARY.length).toBe(BUILT_IN_LIBRARY.length);
    ws = use(resetComponent(ws, firewall.id));
    expect(componentById(firewall.id)?.name).toBe("Next-generation firewall");
    expect(Object.keys(ws.library)).toEqual([]);
  });

  it("copies one as its own, and removes or deletes", () => {
    const s3 = BUILT_IN_LIBRARY.find((c) => c.provider === "aws" && c.name.includes("S3"))!;
    let ws: Workspace = emptyWorkspace("Sara");
    const copy = duplicateComponent(use(ws), s3.id);
    ws = use(copy.ws);
    expect(componentById(copy.id)).toMatchObject({ name: `${s3.name} (copy)`, provider: "aws", custom: true });
    expect(ws.library[copy.id].copiedFrom).toBe(s3.id);

    // Removing a built-in hides it and lists it to put back; the objects made from it keep their type.
    const made = createObject(ws, { typeId: "storage", name: "Archive bucket", componentId: s3.id });
    ws = use(removeComponent(made.ws, s3.id));
    expect(componentById(s3.id)).toBeUndefined();
    expect(removedComponents(ws).map((c) => c.id)).toEqual([s3.id]);
    expect(componentUsers(ws, s3.id).map((o) => o.name)).toEqual(["Archive bucket"]);
    ws = use(resetComponent(ws, s3.id));
    expect(componentById(s3.id)?.name).toBe(s3.name);

    // The workspace's own is deleted outright.
    ws = use(removeComponent(ws, copy.id));
    expect(ws.library[copy.id]).toBeUndefined();
    expect(componentById(copy.id)).toBeUndefined();
  });

  it("ignores a component without a name or in a section that does not exist", () => {
    const ws = emptyWorkspace("Sara");
    expect(saveComponent(ws, { name: "  ", sectionId: "applications", kind: "application", icon: "Box", profile: "generic", aliases: "" }).ws).toBe(ws);
    const lost = saveComponent(ws, { name: "Lost", sectionId: "no-such-section", kind: "application", icon: "Box", profile: "generic", aliases: "" });
    use(lost.ws);
    expect(componentById(lost.id)).toBeUndefined();
  });
});

describe("a workspace's own protocols", () => {
  it("gives every built-in protocol a stable id of its own", () => {
    const ids = BUILT_IN_PROTOCOLS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILT_IN_PROTOCOLS.find((p) => p.name === "HTTPS")?.id).toBe("proto.https.443");
  });

  it("adds, changes, copies and removes, and puts a removed one back", () => {
    let ws = emptyWorkspace("Sara");
    const own = saveProtocol(ws, { name: "Core banking ISO 8583", port: "7001", transport: "TCP", group: "Payments", secure: false, use: "Card authorisations" });
    ws = use(own.ws);
    expect(protocolByName("core banking iso 8583")).toMatchObject({ port: "7001", custom: true });
    expect(PROTOCOLS.length).toBe(BUILT_IN_PROTOCOLS.length + 1);

    const https = BUILT_IN_PROTOCOLS.find((p) => p.name === "HTTPS")!;
    ws = use(saveProtocol(ws, { ...https, use: "Only through the API gateway" }, https.id).ws);
    expect(protocolByName("HTTPS")).toMatchObject({ use: "Only through the API gateway", changed: true });

    const copy = duplicateProtocol(ws, https.id);
    ws = use(copy.ws);
    expect(protocolByName("HTTPS (copy)")?.port).toBe("443");

    const telnet = BUILT_IN_PROTOCOLS.find((p) => p.name === "Telnet")!;
    ws = use(removeProtocol(ws, telnet.id));
    expect(protocolByName("Telnet")).toBeUndefined();
    expect(removedProtocols(ws).map((p) => p.name)).toEqual(["Telnet"]);
    ws = use(resetProtocol(ws, telnet.id));
    expect(protocolByName("Telnet")?.port).toBe("23");

    ws = use(removeProtocol(ws, own.id));
    expect(protocolByName("Core banking ISO 8583")).toBeUndefined();
  });

  it("renames a protocol on the connections that carry it", () => {
    let ws: Workspace = emptyWorkspace("Sara");
    const a = createObject(ws, { typeId: "service", name: "A" });
    const b = createObject(a.ws, { typeId: "service", name: "B" });
    const r = createRelationship(b.ws, { sourceId: a.object.id, targetId: b.object.id, kind: "calls" });
    ws = setProtocols(r.ws, r.relationship!.id, [
      { name: "Card switch", port: "7001", transport: "TCP" },
      { name: "HTTPS", port: "443", transport: "TCP" },
    ]);
    expect(protocolUsers(ws, "card switch")).toBe(1);
    ws = renameOnConnections(ws, { name: "Card switch", port: "7001" }, { name: "ISO 8583", port: "7002", transport: "TCP" });
    const rel = ws.relationships[r.relationship!.id];
    expect(rel.protocols?.map((p) => `${p.name}:${p.port}`)).toEqual(["ISO 8583:7002", "HTTPS:443"]);
    expect(rel.protocol).toBe("ISO 8583, HTTPS");
    expect(protocolUsers(ws, "Card switch")).toBe(0);
  });
});
