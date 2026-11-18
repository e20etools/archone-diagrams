import { describe, expect, it } from "vitest";
import { boxView, roleCell, sealCode, sealOf, shownFields, type DiagramStanding } from "./approvals";
import { copyScope, endOf } from "@/components/approvals/VerifiedCopies";
import { demoFingerprint, diagramTables, roleState, standingOf, type DemoApprovalRequest } from "./cloud/demoApprovals";
import { emptyTables, nodeKey } from "./cloud/tables";
import { TITLE_BLOCK_FIELD_IDS } from "./types";

const approved: DiagramStanding = {
  fingerprint: "a3f912c077b1" + "0".repeat(52),
  status: "approved",
  version: 2,
  approvedVersion: 2,
  approvedAt: "2026-11-18T09:00:00Z",
  approvedFingerprint: "a3f912c077b1" + "0".repeat(52),
  request: null,
  roles: {
    ea: { state: "approved", by: "Erin", at: "2026-11-18T08:00:00Z", note: "", withChanges: true },
    security: { state: "approved", by: "Sam", at: "2026-11-18T09:00:00Z", note: "", withChanges: false },
  },
};

describe("the information box", () => {
  it("shows every field but those the diagram hid, and never hides a required one", () => {
    expect(shownFields(undefined, undefined)).toEqual([...TITLE_BLOCK_FIELD_IDS]);
    expect(shownFields(["seal", "createdBy", "nonsense"], ["seal"])).toEqual(TITLE_BLOCK_FIELD_IDS.filter((f) => f !== "createdBy"));
  });

  it("marks each approval yes only for the diagram as it is, and seals it", () => {
    const view = boxView({ name: "Online store", company: "Gulf Bank", logo: "", standing: approved, created: { at: "2026-11-01T10:00:00Z", by: "Edgar" }, changed: { at: null, by: "" }, fields: TITLE_BLOCK_FIELD_IDS });
    expect(view.company).toEqual({ name: "Gulf Bank", logo: "" });
    const cell = (f: string) => view.cells.find((c) => c.field === f)!;
    expect(cell("version").value).toBe("2 · Approved");
    expect(cell("ea")).toMatchObject({ mark: "yes", value: "Yes · Changed and approved by Erin" });
    expect(cell("security")).toMatchObject({ mark: "yes", value: "Yes · Approved by Sam" });
    expect(cell("changedAt").value).toBe("—");
    expect(cell("seal").value).toBe("A3F9-12C0-77B1 · Original: matches approved version 2");
    expect(view.sealTone).toBe("ok");
    const changed = { ...approved, status: "changed" as const, version: 3, fingerprint: "b".repeat(64), roles: { ...approved.roles, ea: { ...approved.roles.ea, state: "stale" as const } } };
    expect(sealOf(changed)).toMatchObject({ code: "BBBB-BBBB-BBBB", tone: "warn", text: "Differs from approved version 2" });
    expect(roleCell(changed.roles.ea)).toEqual({ yes: false, text: "Changed since it was approved" });
  });

  it("without a shared workspace shows what it knows and dashes for the rest", () => {
    const view = boxView({ name: "Local", company: "Me", logo: "", standing: null, created: { at: "2026-11-01T10:00:00Z", by: "" }, changed: { at: "2026-11-02T10:00:00Z", by: "" }, fields: ["name", "version", "ea", "seal"] });
    expect(view.company).toBeNull();
    expect(view.cells.map((c) => [c.field, c.value])).toEqual([["name", "Local"], ["version", "—"], ["ea", "—"], ["seal", "Approval needs a shared workspace"]]);
    expect(sealCode("nope")).toBe("");
  });
});

describe("verified copies", () => {
  it("end when chosen, within a year", () => {
    const now = Date.parse("2026-11-18T00:00:00Z");
    expect(endOf("24h", "", now)).toBe("2026-11-19T00:00:00.000Z");
    expect(endOf("never", "", now)).toBeNull();
    expect(endOf("custom", "2026-11-18T00:02", now)).toBeUndefined();
    expect(endOf("custom", "2028-01-01T00:00", now)).toBeUndefined();
    expect(endOf("custom", "2026-12-01T10:00", now)).toBe(new Date("2026-12-01T10:00").toISOString());
  });
  it("are of the approved version while approval comes first", () => {
    const record = { ...approved, diagramId: "d", required: true, created: { at: null, by: "" }, changed: { at: null, by: "" }, approvers: { ea: [], security: [] }, mine: { ea: false, security: false }, history: [] };
    expect(copyScope({ ...record, status: "draft", approvedVersion: null }).allowed).toBe(false);
    expect(copyScope({ ...record, status: "changed", version: 3 }).text).toMatch(/version 2, the last approved one/);
    expect(copyScope({ ...record, required: false, status: "pending", version: 3 }).text).toMatch(/as it is now: version 3, waiting for approval/);
  });
});

describe("the stand-in server", () => {
  const tables = () => {
    const t = emptyTables();
    t.objects.a = { id: "a", typeId: "application", name: "Portal", description: "", owner: "", lifecycle: "active", tags: [], parentId: null, technology: "", fields: {}, provenance: { origin: "manual" }, createdAt: "x", updatedAt: "x" } as never;
    t.objects.b = { ...(t.objects.a as object), id: "b", name: "DB" } as never;
    t.relationships.r = { id: "r", sourceId: "a", targetId: "b", kind: "calls", label: "", protocol: "", port: "", description: "", provenance: { origin: "manual" }, createdAt: "x", updatedAt: "x" } as never;
    t.diagrams.d = { id: "d", name: "Store", description: "", viewType: "container", scopeId: null, direction: "TB", hiddenRelationshipIds: [], edgeKinds: null, colorBy: "type", createdAt: "x", updatedAt: "x" } as never;
    t.nodes[nodeKey("d", "a")] = { x: 0, y: 0 } as never;
    t.nodes[nodeKey("d", "b")] = { x: 300, y: 0 } as never;
    return t;
  };

  it("fingerprints what the diagram shows, not when or its box", async () => {
    const t = tables();
    const before = await demoFingerprint(t, "d");
    t.diagrams.d = { ...t.diagrams.d, updatedAt: "y", titleBlock: { show: true, corner: "top-left" } };
    t.nodes[nodeKey("d", "a")] = { x: 0.2, y: 0 } as never;
    expect(await demoFingerprint(t, "d")).toBe(before);
    t.objects.a = { ...t.objects.a, name: "Portal 2" };
    expect(await demoFingerprint(t, "d")).not.toBe(before);
    expect(Object.keys(diagramTables(t, "d").objects)).toEqual(["a", "b"]);
    expect(diagramTables(t, "d").diagrams.d.titleBlock).toBeUndefined();
  });

  it("follows a request through return, changes and both approvals as the database does", () => {
    const at = (n: number) => `2026-11-18T10:00:0${n}Z`;
    const event = (kind: DemoApprovalRequest["events"][number]["kind"], role: "ea" | "security" | null, fingerprint: string, n: number, round = 1) => ({ kind, role, note: "", fingerprint, byId: "u", byName: "U", at: at(n), round });
    const request: DemoApprovalRequest = { id: "q", diagramId: "d", version: 1, status: "pending", round: 1, note: "", fingerprint: "f1", requestedBy: "u", requestedAt: at(0), updatedAt: at(0), events: [event("submitted", null, "f1", 0), event("approved", "ea", "f1", 1)] };
    expect(standingOf([request], "d", "f1")).toMatchObject({ status: "pending", version: 1, roles: { ea: { state: "approved" }, security: { state: "waiting" } } });
    request.events.push(event("returned", "security", "f1", 2));
    request.status = "returned";
    expect(roleState(request, "security", "f1").state).toBe("returned");
    request.events.push(event("resubmitted", null, "f2", 3, 2));
    Object.assign(request, { status: "pending", round: 2, fingerprint: "f2" });
    expect(standingOf([request], "d", "f2").roles).toMatchObject({ ea: { state: "stale" }, security: { state: "waiting" } });
    Object.assign(request, { status: "approved", approvedFingerprint: "f2", closedAt: at(5) });
    request.events.push(event("approved", "security", "f2", 4, 2), event("approved", "ea", "f2", 5, 2), event("completed", null, "f2", 5, 2));
    expect(standingOf([request], "d", "f2")).toMatchObject({ status: "approved", version: 1, approvedVersion: 1 });
    expect(standingOf([request], "d", "f3")).toMatchObject({ status: "changed", version: 2, approvedVersion: 1, roles: { ea: { state: "stale" } } });
  });
});
