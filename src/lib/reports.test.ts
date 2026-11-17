import { describe, expect, it } from "vitest";
import { addEnterpriseSample } from "./enterpriseSample";
import { readXlsx } from "./import/xlsx";
import { emptyWorkspace } from "./model";
import { reportCsv, reportFile, reportHtml, reportJson, reportMarkdown, reportXlsx } from "./reportExport";
import { BUILT_IN_REPORTS, REPORT_AREAS, builtInReport, customReportSchema, deleteReport, newReportId, runCustomReport, saveReport, sortedReports, type CustomReport } from "./reports";

const { ws } = addEnterpriseSample(emptyWorkspace("Bank"));

describe("reports", () => {
  it("every built-in report runs on a real model and on an empty one, with as many cells as columns", () => {
    expect(BUILT_IN_REPORTS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BUILT_IN_REPORTS.map((r) => r.id)).size).toBe(BUILT_IN_REPORTS.length);
    for (const area of REPORT_AREAS) expect(BUILT_IN_REPORTS.some((r) => r.area === area.id), area.id).toBe(true);
    for (const report of BUILT_IN_REPORTS) {
      for (const model of [ws, emptyWorkspace("Empty")]) {
        const result = report.run(model);
        expect(result.columns.length, report.id).toBeGreaterThan(0);
        for (const row of result.rows) expect(row.length, report.id).toBe(result.columns.length);
      }
    }
  });

  it("finds what matters in the bank: Active Directory high in the impact ranking, protocols counted, shared services", () => {
    const ranking = builtInReport("impact-ranking")!.run(ws);
    const top = ranking.rows.slice(0, 10).map((r) => r[0]);
    expect(top).toContain("Active Directory");
    const protocols = builtInReport("protocols-ports")!.run(ws);
    expect(protocols.rows.find((r) => r[0] === "LDAPS")?.[3]).toBeGreaterThanOrEqual(8);
    const shared = builtInReport("shared-components")!.run(ws);
    expect(shared.rows.find((r) => r[0] === "Active Directory")?.[3]).toBeGreaterThanOrEqual(5);
    const clear = builtInReport("clear-text")!.run(ws);
    expect(clear.rows.some((r) => String(r[2]).includes("Syslog"))).toBe(true);
    const zones = builtInReport("network-zones")!.run(ws);
    expect(zones.rows.find((r) => r[0] === "DMZ")?.[1]).toBe(4);
  });

  it("runs a report of the workspace's own: columns, filters, sorting and a grouping", () => {
    const def = { subject: "components", columns: ["name", "type", "owner", "dependedOn"], filters: [{ field: "owner", op: "is", value: "Network team" }], groupBy: "type", sortBy: "dependedOn", sortDesc: true } as const;
    const result = runCustomReport(ws, { ...def, filters: [...def.filters] , columns: [...def.columns] });
    expect(result.columns).toEqual(["Name", "Type", "Owner", "Depended on by (count)"]);
    expect(result.rows.every((r) => r[2] === "Network team")).toBe(true);
    expect(result.rows[0][0]).toBe("Core switch");
    expect(result.chart?.data.find((d) => d.label === "Network zone")?.value).toBe(7);
    const clear = runCustomReport(ws, { subject: "connections", columns: ["from", "to", "clear"], filters: [{ field: "clear", op: "is not empty", value: "" }], groupBy: null, sortBy: null, sortDesc: false });
    expect(clear.rows.length).toBeGreaterThan(0);
    const big = runCustomReport(ws, { subject: "diagrams", columns: ["name", "boxes"], filters: [{ field: "boxes", op: "at least", value: "20" }], groupBy: null, sortBy: "boxes", sortDesc: true });
    expect(big.rows[0][0]).toBe("Data centre network");
  });

  it("keeps the workspace's reports, checked, and deletes them", () => {
    const report: CustomReport = { id: newReportId(), name: "No owner", description: "", subject: "components", columns: ["name"], filters: [], groupBy: null, sortBy: null, sortDesc: false, createdBy: "Sara", createdAt: "2026-11-17", updatedAt: "2026-11-17" };
    let w = saveReport(ws, report);
    expect(sortedReports(w).map((r) => r.name)).toEqual(["No owner"]);
    expect(() => customReportSchema.parse({ ...report, columns: [] })).toThrow();
    w = deleteReport(w, report.id);
    expect(sortedReports(w)).toEqual([]);
  });

  it("exports a report as CSV, Excel, JSON, Markdown and a web page with the same rows", async () => {
    const result = builtInReport("application-portfolio")!.run(ws);
    const doc = { title: "Application portfolio", description: "Every application.", workspace: "Bank", result, at: new Date("2026-11-17T09:00:00Z") };
    const csv = reportCsv(doc).trim().split("\r\n");
    expect(csv).toHaveLength(result.rows.length + 1);
    expect(csv[0]).toBe("Name,Type,Owner,Lifecycle,Technology,Criticality,Tier-1,Diagrams");
    const sheets = await readXlsx(reportXlsx(doc));
    expect(sheets[0].rows).toHaveLength(result.rows.length + 1);
    expect(sheets[1].name).toBe("Summary");
    expect(JSON.parse(reportJson(doc)).rows[0].Name).toBe(result.rows[0][0]);
    expect(reportMarkdown(doc).split("\n").filter((l) => l.startsWith("| ")).length).toBeGreaterThan(result.rows.length);
    const html = reportHtml(doc);
    expect(html).toContain("<svg");
    expect((html.match(/<tr>/g) ?? []).length).toBe(result.rows.length + 1);
    const word = await reportFile(doc, "docx");
    expect(word.blob.size).toBeGreaterThan(5000);
  });
});
