import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyProposal, importUpdates } from "../ai/proposals";
import { demoWorkspace } from "../demo";
import { emptyWorkspace, findByName } from "../model";
import type { Proposal, Workspace } from "../types";
import { decodeText, parseCsv } from "./csv";
import { guessKind, guessType, nestByGeometry, plainLabel } from "./diagramFile";
import { guessMapping, lifecycleFromCell, modelSheets, pageToProposal, remap, sheetsToProposal, typeFromCell } from "./draft";
import { readDrawio } from "./drawio";
import { readVsdx } from "./visio";
import { readXlsx, writeXlsx } from "./xlsx";
import { parseXml, descendants, allText } from "./xml";
import { crc32, readZip, writeZip } from "./zip";

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const accept = (ws: Workspace, proposal: Proposal) => {
  const all: Proposal = { ...proposal, objects: proposal.objects.map((o) => ({ ...o, decision: "accepted" })), relationships: proposal.relationships.map((r) => ({ ...r, decision: "accepted" })) };
  return applyProposal({ ...ws, proposals: { ...ws.proposals, [all.id]: all } }, all.id, "Tester");
};

describe("zip", () => {
  it("reads back what it writes, stored or deflated", async () => {
    const files = { "a.txt": "hello", "folder/b.xml": "<x>é</x>".repeat(500) };
    for (const deflate of [undefined, (data: Uint8Array) => new Uint8Array(deflateRawSync(data))]) {
      const read = await readZip(writeZip(files, deflate));
      expect([...read.keys()]).toEqual(["a.txt", "folder/b.xml"]);
      expect(new TextDecoder().decode(read.get("folder/b.xml"))).toBe(files["folder/b.xml"]);
    }
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("refuses files that are not archives, and damaged ones, with a reason", async () => {
    await expect(readZip(new TextEncoder().encode("just some text, long enough to look at"))).rejects.toThrow(/not a valid file/);
    const good = writeZip({ "a.txt": "hello" });
    await expect(readZip(good.slice(0, good.length - 30))).rejects.toThrow(/not a valid file|damaged/);
  });
});

describe("xml", () => {
  it("reads elements, attributes, entities, CDATA and namespaces", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><a:root xmlns:a="u" title="1 &lt; 2 &amp; &#x41;&#66;"><a:item r:id='x>y'>one<![CDATA[ <two> ]]></a:item><empty/></a:root>`);
    expect(root.name).toBe("root");
    expect(root.attrs.title).toBe("1 < 2 & AB");
    expect(root.children.map((c) => c.name)).toEqual(["item", "empty"]);
    expect(root.children[0].attrs.id).toBe("x>y");
    expect(allText(root)).toBe("one <two> ");
    expect(descendants(root, "item")).toHaveLength(1);
  });

  it("never expands entities a file declares for itself", () => {
    const root = parseXml(`<!DOCTYPE x [<!ENTITY big "AAAAAAAAAA"><!ENTITY file SYSTEM "file:///etc/passwd">]><x>&big;&file;</x>`);
    expect(root.text).toBe("&big;&file;");
  });

  it("says so when a file is cut off", () => {
    expect(() => parseXml("<a><b></a")).toThrow(/damaged/);
    expect(() => parseXml("")).toThrow(/empty/);
  });
});

describe("csv", () => {
  it("works out the delimiter and keeps quoted cells whole", () => {
    const rows = parseCsv(decodeText(fixture("apps-semicolon.csv")));
    expect(rows).toEqual([
      ["Name", "Type", "Owner", "Description"],
      ["Fraud check", "Service", "Risk; Compliance", "Scores every payment\nbefore capture"],
      ["Card vault", "Database", "Risk", ""],
    ]);
    expect(parseCsv('﻿a,b\r\n"say ""hi""",2\r\n\r\n')).toEqual([["a", "b"], ['say "hi"', "2"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads files Excel saved in the older Windows encoding", () => {
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeText(new TextEncoder().encode("Café"))).toBe("Café");
  });
});

describe("excel workbooks", () => {
  it("reads a workbook written by another program: text, numbers, dates, several sheets, hidden ones left out", async () => {
    const sheets = await readXlsx(fixture("applications.xlsx"));
    expect(sheets.map((s) => s.name)).toEqual(["Applications", "Integrations", "Read me"]);
    const [apps, links] = sheets;
    expect(apps.rows[0].slice(0, 4)).toEqual(["Application Name", "Category", "Summary", "Business Owner"]);
    expect(apps.rows[1]).toEqual(["Billing Portal", "Web app", "Customers pay invoices here", "Finance IT", "In production", "React", "pci; customer", "Billing", "2024-03-01", "1200"]);
    expect(apps.rows[2][2]).toBe("Creates & sends invoices <PDF>");
    expect(apps.rows[2][9]).toBe("0.3");
    expect(links.rows[1]).toEqual(["Billing Portal", "Invoice API", "Calls", "creates invoices", "HTTPS", "443"]);
  });

  it("reads a workbook saved by LibreOffice", async () => {
    const [sheet] = await readXlsx(fixture("libreoffice.xlsx"));
    expect(sheet.rows).toEqual([["Name", "Type", "Owner"], ["État civil", "Database", "Mairie"], ["Portal, public", "Web app", "IT"]]);
  });

  it("writes a workbook it can read back, whatever the text", async () => {
    const rows = [["Name", "Note"], ["A & B <tag>", 'He said "hi"\nline two'], ["", "after an empty cell"], ["数据库 ✓", " leading space"]];
    const [back] = await readXlsx(writeXlsx([{ name: "Objects: all/of them?", rows }]));
    expect(back.name).toBe("Objects  all of them");
    expect(back.rows).toEqual(rows);
  });

  it("says what is wrong with a file that is not a workbook", async () => {
    await expect(readXlsx(writeZip({ "word/document.xml": "<w/>" }))).rejects.toThrow(/does not look like an Excel workbook/);
    await expect(readXlsx(fixture("apps-semicolon.csv"))).rejects.toThrow(/not a valid file/);
  });
});

describe("spreadsheet import", () => {
  it("recognises what a sheet holds and which column is which", async () => {
    const sheets = await readXlsx(fixture("applications.xlsx"));
    const [apps, links, readme] = sheets.map(guessMapping);
    expect(apps.role).toBe("objects");
    expect(apps.columns).toMatchObject({ name: 0, type: 1, description: 2, owner: 3, lifecycle: 4, technology: 5, tags: 6, parent: 7 });
    expect(links.role).toBe("relationships");
    expect(links.columns).toMatchObject({ from: 0, to: 1, kind: 2, label: 3, protocol: 4, port: 5, description: null });
    expect(readme.role).toBe("skip");
    expect(remap(sheets[0], "relationships").columns.from).toBeNull();
  });

  it("reads type and lifecycle cells written in people's own words", () => {
    expect(typeFromCell("Service or API")).toBe("service");
    expect(typeFromCell("web-app")).toBe("web-app");
    expect(typeFromCell("Oracle database")).toBe("database");
    expect(typeFromCell("Telephony thing")).toBeNull();
    expect(lifecycleFromCell("In production")).toBe("active");
    expect(lifecycleFromCell("Decommissioned")).toBe("retired");
    expect(lifecycleFromCell("Legacy")).toBe("deprecated");
    expect(lifecycleFromCell("???")).toBeNull();
  });

  it("builds a draft from the rows and reports what it left out or had to add", async () => {
    const sheets = await readXlsx(fixture("applications.xlsx"));
    const { proposal, report } = sheetsToProposal(emptyWorkspace("Test"), sheets, sheets.map(guessMapping), "applications.xlsx");
    expect(report).toMatchObject({ objectRows: 4, relationshipRows: 3, skippedCount: 2, unknownTypes: ["Telephony thing"], implied: 2 });
    expect(report.skipped.map((s) => `${s.sheet} ${s.row}: ${s.reason}`)).toEqual(["Applications 5: No name", "Integrations 5: The From or To cell is empty"]);
    const named = Object.fromEntries(proposal.objects.map((o) => [o.name, o]));
    expect(named["Billing Portal"]).toMatchObject({ typeId: "web-app", owner: "Finance IT", lifecycle: "active", technology: "React", tags: ["pci", "customer"] });
    expect(named["Ledger DB"].lifecycle).toBe("deprecated");
    expect(named["Fax Gateway"]).toMatchObject({ typeId: "application", lifecycle: "retired" });
    // "Billing" is only named as a parent, so it is added one level above its children.
    expect(named.Billing.typeId).toBe("system");
    expect(named["Invoice API"].parentKey).toBe(named.Billing.key);
    expect(proposal.relationships.map((r) => `${r.kind} ${r.label} ${r.protocol ?? ""}:${r.port ?? ""}`)).toEqual(["calls creates invoices HTTPS:443", "reads_writes stores postings JDBC:1521", "depends_on  :"]);
    expect(proposal).toMatchObject({ origin: "import", importKind: "spreadsheet", withoutDiagram: true, engine: "Spreadsheet import" });
  });

  it("saves accepted rows to the model with the file as their origin, and draws nothing", async () => {
    const sheets = await readXlsx(fixture("applications.xlsx"));
    const start = emptyWorkspace("Test");
    const result = accept(start, sheetsToProposal(start, sheets, sheets.map(guessMapping), "applications.xlsx").proposal);
    expect(result).toMatchObject({ createdObjects: 6, createdRelationships: 3, diagramId: null });
    const portal = findByName(result.ws, "billing portal")!;
    expect(portal).toMatchObject({ owner: "Finance IT", technology: "React", parentId: findByName(result.ws, "Billing")!.id });
    expect(portal.provenance).toMatchObject({ origin: "import", source: "applications.xlsx", approvedBy: "Tester" });
    expect(Object.keys(result.ws.diagrams)).toHaveLength(0);
  });

  it("updates an object that is already in the model, only in the columns the file fills", async () => {
    const sheets = await readXlsx(fixture("applications.xlsx"));
    const first = accept(emptyWorkspace("Test"), sheetsToProposal(emptyWorkspace("Test"), sheets, sheets.map(guessMapping), "a.xlsx").proposal).ws;
    const edited = [{ name: "Apps", rows: [["Name", "Owner", "Description", "Status"], ["billing portal", "Payments team", "", ""], ["Ledger DB", "Data Platform", "", "retired"]] }];
    const { proposal } = sheetsToProposal(first, edited, edited.map(guessMapping), "b.csv");
    expect(proposal.objects.map((o) => [o.name, !!o.matchId, importUpdates(first, { ...o, matchId: findByName(first, o.name)?.id ?? null })])).toEqual([
      ["Billing Portal", true, ["Owner"]],
      ["Ledger DB", true, ["Lifecycle"]],
    ]);
    const result = accept(first, proposal);
    expect(result).toMatchObject({ createdObjects: 0, reusedObjects: 2, updatedObjects: 2 });
    const portal = findByName(result.ws, "Billing Portal")!;
    // The empty Description cell did not wipe the description, and the type was left alone.
    expect(portal).toMatchObject({ owner: "Payments team", description: "Customers pay invoices here", typeId: "web-app", lifecycle: "active" });
    expect(findByName(result.ws, "Ledger DB")!.lifecycle).toBe("retired");
  });

  it("exports the model to a workbook that imports back as no change at all", async () => {
    const ws = demoWorkspace("Tester");
    const sheets = await readXlsx(writeXlsx(modelSheets(ws)));
    expect(sheets.map((s) => `${s.name} ${s.rows.length - 1}`)).toEqual([`Objects ${Object.keys(ws.objects).length}`, `Relationships ${Object.keys(ws.relationships).length}`]);
    const { proposal, report } = sheetsToProposal(ws, sheets, sheets.map(guessMapping), "export.xlsx");
    expect(report).toMatchObject({ skippedCount: 0, unknownTypes: [], implied: 0 });
    expect(proposal.objects.every((o) => o.matchId && importUpdates(ws, o).length === 0)).toBe(true);
    const result = accept(ws, proposal);
    expect(result).toMatchObject({ createdObjects: 0, updatedObjects: 0, createdRelationships: 0 });
    expect(result.ws.objects).toEqual(ws.objects);
  });
});

describe("draw.io files", () => {
  it("reads plain and compressed pages: shapes, nesting, arrows and their labels", async () => {
    const pages = await readDrawio(new TextDecoder().decode(fixture("shop.drawio")));
    expect(pages.map((p) => p.name)).toEqual(["Shop", "Compressed page"]);
    const [shop, second] = pages;
    const byId = Object.fromEntries(shop.shapes.map((s) => [s.id, s]));
    expect(shop.shapes.map((s) => s.text)).toEqual(["Payments platform", "Web shop", "Orders\nservice", "Orders DB", "Customer", "Order events"]);
    // A shape inside a container is placed relative to it in the file, and on the page here.
    expect(byId.web).toMatchObject({ x: 70, y: 100, parentId: "zone" });
    // The icon had no label of its own; the text under it names it.
    expect(byId.icon.text).toBe("Order events");
    expect(shop.connectors.map((c) => `${c.sourceId}>${c.targetId} ${c.text}`)).toEqual(["user>web places orders", "web>orders REST", "orders>db ", "orders>icon publishes"]);
    expect(shop.skipped).toEqual({ unlabelled: 1, loose: 2, notes: 1 });
    expect(second.shapes.map((s) => s.text)).toEqual(["Gateway", "Réplica ✓"]);
    expect(second.connectors).toHaveLength(1);
  });

  it("explains files that are something else", async () => {
    await expect(readDrawio("<svg></svg>")).rejects.toThrow(/not a draw.io diagram/);
    await expect(readDrawio("not xml at all <")).rejects.toThrow(/could not be read/);
  });

  it("becomes a draft with types guessed from the shapes, and a diagram laid out as it was drawn", async () => {
    const [shop] = await readDrawio(new TextDecoder().decode(fixture("shop.drawio")));
    const start = emptyWorkspace("Test");
    const proposal = pageToProposal(start, shop, "drawio", "shop.drawio");
    const named = Object.fromEntries(proposal.objects.map((o) => [o.name, o]));
    expect(Object.fromEntries(proposal.objects.map((o) => [o.name, o.typeId]))).toEqual({ "Payments platform": "system", "Web shop": "application", Orders: "service", "Orders DB": "database", Customer: "actor", "Order events": "queue" });
    expect(named.Orders.description).toBe("service");
    expect(named["Web shop"].parentKey).toBe(named["Payments platform"].key);
    // The container frames its children; it is not a box of its own.
    expect(named["Payments platform"].x).toBeUndefined();
    expect(proposal.relationships.map((r) => r.kind)).toEqual(["calls", "calls", "reads_writes", "reads_writes"]);
    expect(proposal.notes).toMatch(/1 shape without a label/);

    const result = accept(start, proposal);
    const diagram = result.ws.diagrams[result.diagramId!];
    expect(diagram.name).toBe("shop");
    expect(Object.keys(diagram.nodes)).toHaveLength(5);
    const at = (name: string) => diagram.nodes[findByName(result.ws, name)!.id];
    // Left of, and above, as in the file; far enough apart that boxes do not overlap.
    expect(at("Orders").x - at("Web shop").x).toBeGreaterThanOrEqual(216 + 20);
    expect(at("Orders DB").y - at("Orders").y).toBeGreaterThanOrEqual(78 + 20);
    expect(at("Orders DB").x).toBe(at("Orders").x);
    expect(at("Web shop").pinned).toBe(true);
    expect(findByName(result.ws, "Web shop")!.provenance).toMatchObject({ origin: "import", engine: "draw.io import" });
  });
});

describe("Visio drawings", () => {
  it("reads shapes, stencil names, grouped icons, and connectors glued or merely drawn up to a shape", async () => {
    const pages = await readVsdx(fixture("order-flow.vsdx"));
    // The background page is not a diagram.
    expect(pages.map((p) => p.name)).toEqual(["Page-1"]);
    const [page] = pages;
    expect(page.shapes.map((s) => `${s.id}:${s.text.replace("\n", "/")}`)).toEqual(["1:Web portal", "2:Order service/(Java)", "3:Orders database", "4:Payment provider"]);
    // The database took its text and size from the stencil.
    expect(page.shapes[2]).toMatchObject({ hint: "Database", width: 96, height: 115.2 });
    // Visio measures upwards from the bottom of the page; here y grows downwards.
    expect(page.shapes[2].y).toBeGreaterThan(page.shapes[1].y);
    expect(page.connectors.map((c) => `${c.sourceId}>${c.targetId} ${c.text}`)).toEqual(["1>2 submits orders", "2>3 ", "2>4 takes payment through"]);
    expect(page.skipped).toEqual({ unlabelled: 1, loose: 1, notes: 0 });
  });

  it("becomes a draft, and is refused with a reason when it is not a .vsdx", async () => {
    const [page] = await readVsdx(fixture("order-flow.vsdx"));
    const proposal = pageToProposal(emptyWorkspace("Test"), page, "visio", "order-flow.vsdx");
    expect(Object.fromEntries(proposal.objects.map((o) => [o.name, o.typeId]))).toEqual({ "Web portal": "web-app", "Order service": "service", "Orders database": "database", "Payment provider": "application" });
    expect(proposal.relationships.map((r) => r.kind)).toEqual(["calls", "reads_writes", "calls"]);
    await expect(readVsdx(fixture("applications.xlsx"))).rejects.toThrow(/not a Visio drawing/);
    await expect(readVsdx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]))).rejects.toThrow(/Older .vsd files/);
  });
});

describe("guessing from shapes and labels", () => {
  it("cleans labels and reads types and relationship kinds from words", () => {
    expect(plainLabel("<div>Orders<br/>service&nbsp;&amp; API</div>")).toBe("Orders\nservice & API");
    expect(guessType("shape=cylinder3;whiteSpace=wrap", "Stuff")).toBe("database");
    expect(guessType("rounded=1", "Kafka topic")).toBe("queue");
    expect(guessType("rounded=1", "Something")).toBeNull();
    expect(guessKind("replicates nightly", "database", "database")).toBe("replicates_to");
    expect(guessKind("", "service", "cache")).toBe("reads_writes");
    expect(guessKind("", "gateway", "service")).toBe("routes_to");
  });

  it("treats a shape that encloses others as their parent", () => {
    const box = (id: string, x: number, y: number, width: number, height: number) => ({ id, text: id, x, y, width, height, parentId: null, hint: "" });
    const nested = nestByGeometry([box("outer", 0, 0, 500, 400), box("inner", 20, 20, 200, 200), box("leaf", 40, 40, 80, 40), box("apart", 600, 0, 80, 40)]);
    expect(nested.map((s) => s.parentId)).toEqual([null, "outer", "inner", null]);
  });
});
