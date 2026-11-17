import { ArrowDown, ArrowUp, BarChart3, Copy, Download, FileBarChart, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Input, Modal, Select, Textarea, cx } from "@/components/ui";
import { useCanEdit } from "@/lib/cloud/session";
import { downloadBlob, slugify } from "@/lib/exporters";
import { nowIso } from "@/lib/model";
import { REPORT_FORMATS, reportFile, type ReportFormat } from "@/lib/reportExport";
import {
  BUILT_IN_REPORTS,
  FILTER_OPS,
  REPORT_AREAS,
  REPORT_SUBJECTS,
  builtInReport,
  deleteReport,
  fieldsOf,
  newReportId,
  runCustomReport,
  saveReport,
  sortedReports,
  type Cell,
  type CustomReport,
  type FilterOp,
  type ReportResult,
  type ReportSubject,
} from "@/lib/reports";
import { apply, useWorkspace } from "@/lib/store";

const ROW_LIMIT = 300;

/**
 * Reports: the built-in ones by area, and the workspace's own, each a table with its chart,
 * filtered and sorted on the page and exported in eight formats.
 */
export function ReportsPage() {
  const ws = useWorkspace();
  const canEdit = useCanEdit();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<CustomReport | "new" | null>(null);
  const mine = sortedReports(ws);
  const selected = params.get("report") ?? BUILT_IN_REPORTS[0].id;
  const builtIn = builtInReport(selected);
  const custom = ws.reports?.[selected];
  const q = query.trim().toLowerCase();
  const pick = (id: string) => setParams({ report: id });

  return (
    <div className="flex h-full min-h-0" data-reports-page>
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface px-3 py-4" aria-label="Reports">
        <div className="flex items-center justify-between px-1">
          <h1 className="text-base font-semibold">Reports</h1>
          {canEdit && (
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing("new")} data-report-new>
              New report
            </Button>
          )}
        </div>
        <div className="relative mt-3">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <Input className="h-8 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a report" aria-label="Find a report" />
        </div>
        {(mine.length > 0 || !q) && (
          <section className="mt-4">
            <h2 className="px-1 text-xs font-semibold text-ink-soft">Your reports</h2>
            <ul className="mt-1 space-y-0.5" data-reports-mine={mine.length}>
              {mine
                .filter((r) => !q || r.name.toLowerCase().includes(q))
                .map((r) => (
                  <li key={r.id}>
                    <ReportLink active={selected === r.id} title={r.name} onClick={() => pick(r.id)} data={r.id} />
                  </li>
                ))}
              {!mine.length && <li className="px-1 text-xs text-ink-faint">{canEdit ? "Make one with New report: pick what to list, the columns, filters and a grouping." : "None yet."}</li>}
            </ul>
          </section>
        )}
        {REPORT_AREAS.map((area) => {
          const reports = BUILT_IN_REPORTS.filter((r) => r.area === area.id && (!q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)));
          if (!reports.length) return null;
          return (
            <section key={area.id} className="mt-4">
              <h2 className="px-1 text-xs font-semibold text-ink-soft">{area.label}</h2>
              <ul className="mt-1 space-y-0.5">
                {reports.map((r) => (
                  <li key={r.id}>
                    <ReportLink active={selected === r.id} title={r.title} onClick={() => pick(r.id)} data={r.id} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {builtIn ? (
          <ReportView key={builtIn.id} title={builtIn.title} description={builtIn.description} result={builtIn.run(ws)} workspace={ws.name} />
        ) : custom ? (
          <ReportView
            key={custom.id}
            title={custom.name}
            description={custom.description || `Your own report of ${custom.subject}.`}
            result={runCustomReport(ws, custom)}
            workspace={ws.name}
            actions={
              canEdit && (
                <>
                  <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(custom)} data-report-edit>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    icon={<Copy size={13} />}
                    onClick={() => {
                      const copy = { ...custom, id: newReportId(), name: `${custom.name} (copy)`.slice(0, 120), createdAt: nowIso(), updatedAt: nowIso() };
                      apply((w) => saveReport(w, copy));
                      pick(copy.id);
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={13} />}
                    data-report-delete
                    onClick={() => {
                      apply((w) => deleteReport(w, custom.id));
                      pick(BUILT_IN_REPORTS[0].id);
                    }}
                  >
                    Delete
                  </Button>
                </>
              )
            }
          />
        ) : (
          <p className="text-ink-soft">That report is no longer here.</p>
        )}
      </main>
      {editing && (
        <ReportBuilder
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(report) => {
            apply((w) => saveReport(w, report));
            setEditing(null);
            pick(report.id);
          }}
        />
      )}
    </div>
  );
}

function ReportLink({ active, title, onClick, data }: { active: boolean; title: string; onClick: () => void; data: string }) {
  return (
    <button type="button" onClick={onClick} data-report-link={data} aria-current={active ? "page" : undefined} className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", active ? "bg-blueprint-soft font-medium text-blueprint-deep" : "hover:bg-paper")}>
      <FileBarChart size={14} className="shrink-0 opacity-70" />
      <span className="truncate">{title}</span>
    </button>
  );
}

/* ---------- one report ---------- */

function ReportView({ title, description, result, workspace, actions }: { title: string; description: string; result: ReportResult; workspace: string; actions?: React.ReactNode }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const f = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    let out = f ? result.rows.filter((r) => r.some((c) => String(c).toLowerCase().includes(f))) : result.rows;
    if (sort) {
      out = [...out].sort((a, b) => {
        const x = a[sort.col];
        const y = b[sort.col];
        const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.desc ? -order : order;
      });
    }
    return out;
  }, [result, f, sort]);
  const exportAs = async (format: ReportFormat) => {
    setBusy(format);
    setProblem("");
    try {
      const { blob, ext } = await reportFile({ title, description, workspace, result: { ...result, rows } }, format);
      downloadBlob(`${slugify(title)}.${ext}`, blob);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The report could not be made.");
    } finally {
      setBusy("");
    }
  };
  return (
    <div data-report-view={title}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-0.5 text-ink-soft">{description}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">{actions}</div>
      </div>
      {result.note && <p className="mt-3 rounded-md border-l-4 border-blueprint bg-paper px-3 py-2 text-[13px]" data-report-note>{result.note}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5" data-report-export>
        <span className="mr-1 flex items-center gap-1 text-[13px] text-ink-soft">
          <Download size={14} /> Export
        </span>
        {REPORT_FORMATS.map((x) => (
          <Button key={x.id} size="sm" onClick={() => void exportAs(x.id)} disabled={!!busy} data-report-format={x.id}>
            {busy === x.id ? "Making…" : x.label}
          </Button>
        ))}
        {problem && (
          <span role="alert" className="text-[13px] text-danger">
            {problem}
          </span>
        )}
      </div>
      {result.chart && result.chart.data.length > 0 && <Bars chart={result.chart} />}
      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
          <div className="relative w-64">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <Input className="h-8 pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the rows" aria-label="Filter the rows" />
          </div>
          <span className="text-[13px] text-ink-soft" data-report-rows={rows.length}>
            {rows.length === result.rows.length ? `${rows.length} rows` : `${rows.length} of ${result.rows.length} rows`}
          </span>
          <span className="ml-auto text-xs text-ink-faint">Click a heading to sort. Exports carry the rows shown.</span>
        </div>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-paper text-ink-soft">
                <tr>
                  {result.columns.map((c, i) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort(sort?.col === i ? { col: i, desc: !sort.desc } : { col: i, desc: false })}>
                        {c}
                        {sort?.col === i && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(all ? rows : rows.slice(0, ROW_LIMIT)).map((r, i) => (
                  <tr key={i} className="border-t border-line-soft align-top">
                    {result.columns.map((_, j) => (
                      <td key={j} className={cx("px-3 py-1.5", typeof r[j] === "number" && "text-right tabular-nums")}>
                        {cellText(r[j])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!all && rows.length > ROW_LIMIT && (
              <div className="border-t border-line-soft px-3 py-2 text-center">
                <Button size="sm" onClick={() => setAll(true)}>
                  Show all {rows.length} rows
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="px-3 py-6 text-center text-[13px] text-ink-soft">{result.rows.length ? "No row matches." : "Nothing to report: the model has nothing of this kind yet."}</p>
        )}
      </section>
    </div>
  );
}

const cellText = (c: Cell | undefined) => (c === undefined || c === "" ? <span className="text-ink-faint">–</span> : String(c));

function Bars({ chart }: { chart: NonNullable<ReportResult["chart"]> }) {
  const data = chart.data.slice(0, 12);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <section className="mt-4 rounded-lg border border-line bg-surface px-4 py-3" data-report-chart={data.length}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
        <BarChart3 size={14} className="text-blueprint" /> {chart.title}
      </h3>
      <ul className="mt-2 space-y-1">
        {data.map((d) => (
          <li key={d.label} className="grid grid-cols-[180px_1fr_48px] items-center gap-2 text-[13px]">
            <span className="truncate text-ink-soft" title={d.label}>
              {d.label}
            </span>
            <span className="h-3 rounded-sm bg-line-soft">
              <span className="block h-full rounded-sm bg-blueprint" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
            </span>
            <span className="text-right tabular-nums">{d.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------- making a report ---------- */

function ReportBuilder({ initial, onClose, onSave }: { initial: CustomReport | null; onClose: () => void; onSave: (r: CustomReport) => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [subject, setSubject] = useState<ReportSubject>(initial?.subject ?? "components");
  const [columns, setColumns] = useState<string[]>(initial?.columns ?? ["name", "type", "owner", "lifecycle"]);
  const [filters, setFilters] = useState<{ field: string; op: FilterOp; value: string }[]>(initial?.filters ?? []);
  const [groupBy, setGroupBy] = useState<string | null>(initial?.groupBy ?? null);
  const [sortBy, setSortBy] = useState<string | null>(initial?.sortBy ?? null);
  const [sortDesc, setSortDesc] = useState(initial?.sortDesc ?? false);
  const fields = fieldsOf(subject);
  const changeSubject = (next: ReportSubject) => {
    setSubject(next);
    const f = fieldsOf(next);
    setColumns(f.slice(0, 4).map((x) => x.id));
    setFilters([]);
    setGroupBy(null);
    setSortBy(null);
  };
  const preview = useMemo(() => (columns.length ? runCustomReport(ws, { subject, columns, filters, groupBy, sortBy, sortDesc }) : null), [ws, subject, columns, filters, groupBy, sortBy, sortDesc]);
  const ready = name.trim() && columns.length;
  const save = () =>
    onSave({
      id: initial?.id ?? newReportId(),
      name: name.trim(),
      description: description.trim(),
      subject,
      columns,
      filters,
      groupBy,
      sortBy,
      sortDesc,
      createdBy: initial?.createdBy ?? ws.userName,
      createdAt: initial?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    });
  return (
    <Modal
      title={initial ? "Edit the report" : "New report"}
      onClose={onClose}
      width={880}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!ready} data-report-save>
            Save the report
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1fr]" data-report-builder>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="For example: Applications without an owner" aria-label="Report name" data-report-name />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">What it is for (optional)</span>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} aria-label="Report description" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">What it lists</span>
            <Select value={subject} onChange={(e) => changeSubject(e.target.value as ReportSubject)} aria-label="What the report lists" data-report-subject>
              {REPORT_SUBJECTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </label>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Columns, in the order ticked</span>
            <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto rounded-md border border-line px-2.5 py-2" data-report-columns>
              {fields.map((f) => (
                <label key={f.id} className="flex items-center gap-1.5 text-[13px]">
                  <input type="checkbox" checked={columns.includes(f.id)} data-report-column={f.id} onChange={(e) => setColumns(e.target.checked ? [...columns, f.id] : columns.filter((c) => c !== f.id))} />
                  {f.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Only the rows where</span>
            <ul className="space-y-1.5">
              {filters.map((flt, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <Select className="h-8 flex-1" value={flt.field} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} aria-label="Filter field" data-report-filter-field={i}>
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select className="h-8 w-36" value={flt.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)))} aria-label="Filter test" data-report-filter-op={i}>
                    {FILTER_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </Select>
                  {flt.op !== "is empty" && flt.op !== "is not empty" && (
                    <Input className="h-8 w-32" value={flt.value} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label="Filter value" data-report-filter-value={i} />
                  )}
                  <button type="button" aria-label="Remove this condition" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {filters.length < 12 && (
              <Button size="sm" className="mt-1.5" icon={<Plus size={13} />} onClick={() => setFilters([...filters, { field: fields[0].id, op: "contains", value: "" }])} data-report-filter-add>
                Add a condition
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Count by (chart)</span>
              <Select value={groupBy ?? ""} onChange={(e) => setGroupBy(e.target.value || null)} aria-label="Count by" data-report-group>
                <option value="">No chart</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Sort by</span>
              <span className="flex gap-1">
                <Select value={sortBy ?? ""} onChange={(e) => setSortBy(e.target.value || null)} aria-label="Sort by">
                  <option value="">First column</option>
                  {fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </Select>
                <Button size="sm" aria-label={sortDesc ? "Largest first" : "Smallest first"} onClick={() => setSortDesc(!sortDesc)}>
                  {sortDesc ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
                </Button>
              </span>
            </label>
          </div>
        </div>
        <div className="min-w-0">
          <span className="mb-1 block text-xs text-ink-soft">Preview</span>
          {preview ? (
            <div className="rounded-md border border-line" data-report-preview={preview.rows.length}>
              <p className="border-b border-line-soft px-2.5 py-1.5 text-xs text-ink-soft">{preview.note}</p>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-paper">
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 25).map((r, i) => (
                      <tr key={i} className="border-t border-line-soft">
                        {r.map((c, j) => (
                          <td key={j} className="px-2 py-1">
                            {String(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.chart && <p className="border-t border-line-soft px-2.5 py-1.5 text-xs text-ink-soft">{preview.chart.title}: {preview.chart.data.slice(0, 5).map((d) => `${d.label} ${d.value}`).join(", ")}</p>}
            </div>
          ) : (
            <p className="text-[13px] text-ink-soft">Tick at least one column.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
