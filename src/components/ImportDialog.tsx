import type { ViewType } from "@/lib/types";
import { Cloud, FileCode2, FileSpreadsheet, FileUp, ScanSearch, Workflow } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TypeOptions } from "@/components/ObjectPanel";
import { Button, Field, Modal, Select, countOf, cx } from "@/components/ui";
import { saveProposal } from "@/lib/ai/proposals";
import { useCanEdit } from "@/lib/cloud/session";
import { decodeText, parseCsv } from "@/lib/import/csv";
import type { ImportedPage } from "@/lib/import/diagramFile";
import { fieldsOf, guessMapping, pageToProposal, remap, sheetsToProposal, textModelToProposal, type SheetMapping, type SheetRole } from "@/lib/import/draft";
import { ApmImport } from "@/components/ApmImport";
import { DiscoverImport } from "@/components/DiscoverImport";
import { archimate4Notes, isArchimate, readArchimate } from "@/lib/import/archimate";
import { readDrawio } from "@/lib/import/drawio";
import { isMermaid, readMermaid, type TextModel } from "@/lib/import/mermaid";
import { isStructurizr, readStructurizr } from "@/lib/import/structurizr";
import { readVsdx } from "@/lib/import/visio";
import { readXlsx, type Sheet } from "@/lib/import/xlsx";
import { apply, useWorkspace } from "@/lib/store";
import type { Proposal } from "@/lib/types";
import { inventoryToProposal, readInventory, type Inventory, type InventoryHint } from "@/lib/inventory";

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ".xlsx,.csv,.tsv,.txt,.vsdx,.drawio,.xml,.archimate,.mmd,.mermaid,.md,.markdown,.dsl,.tf,.hcl,.tfstate,.json,.jsonl,.yaml,.yml,.bicep";

type Loaded =
  | { kind: "sheets"; fileName: string; sheets: Sheet[]; notes?: string[] }
  | { kind: "pages"; fileName: string; format: "visio" | "drawio"; pages: ImportedPage[] }
  | { kind: "text"; fileName: string; format: "mermaid" | "structurizr"; model: TextModel }
  | { kind: "inventory"; fileName: string; inventory: Inventory; source: string; importKind?: "iac" | "discovery" };

/** Whether an inventory came from code (Terraform, templates, manifests) or from what is running. */
const DISCOVERY_FORMATS = /AWS Config|Resource Explorer|tagged resources|Resource Graph|Asset Inventory|ServiceNow|BMC|Device42|discovery tool/;
const inventoryKind = (inventory: Inventory): "iac" | "discovery" => (DISCOVERY_FORMATS.test(inventory.format) ? "discovery" : "iac");

/** Reads a chosen file into sheets or diagram pages. Every refusal says what to do about it. */
async function load(file: File, hint: InventoryHint): Promise<Loaded> {
  const name = file.name;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (file.size > MAX_BYTES) throw new Error(`"${name}" is larger than 25 MB. Split it into smaller files.`);
  if (extension === "xls") throw new Error("This is the older Excel format. Open it in Excel, save it as .xlsx, and import that.");
  if (extension === "vsd") throw new Error("This is the older Visio format. Open it in Visio, save it as .vsdx, and import that.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (extension === "xlsx") {
    const sheets = await readXlsx(bytes);
    if (!sheets.length) throw new Error(`"${name}" has no sheet with rows in it.`);
    return { kind: "sheets", fileName: name, sheets };
  }
  if (extension === "mmd" || extension === "mermaid") return { kind: "text", fileName: name, format: "mermaid", model: readMermaid(decodeText(bytes)) };
  if (extension === "dsl") return { kind: "text", fileName: name, format: "structurizr", model: readStructurizr(decodeText(bytes)) };
  if (extension === "md" || extension === "markdown" || extension === "txt") {
    // A text or Markdown file is read as a diagram when it holds one; a .txt that does not is a table, as before.
    const source = decodeText(bytes);
    if (isMermaid(source)) return { kind: "text", fileName: name, format: "mermaid", model: readMermaid(source) };
    if (isStructurizr(source)) return { kind: "text", fileName: name, format: "structurizr", model: readStructurizr(source) };
    if (extension !== "txt") throw new Error(`No Mermaid flowchart or C4 diagram was found in "${name}". In a Markdown file it has to sit in a block that starts with \`\`\`mermaid.`);
  }
  if (extension === "csv" || extension === "tsv" || extension === "txt") {
    const rows = parseCsv(decodeText(bytes));
    if (rows.length < 2) throw new Error(`"${name}" needs a first row of column headings and at least one row under it.`);
    return { kind: "sheets", fileName: name, sheets: [{ name: name.replace(/\.[^.]+$/, ""), rows }] };
  }
  if (extension === "vsdx") return { kind: "pages", fileName: name, format: "visio", pages: await readVsdx(bytes) };
  if (extension === "xml" || extension === "archimate") {
    const source = decodeText(bytes);
    // A file saved by Archi itself (.archimate) is not the exchange format; the reader says how to get one.
    if (isArchimate(source) || extension === "archimate") return { kind: "sheets", fileName: name, sheets: readArchimate(source), notes: archimate4Notes(source) };
  }
  if (extension === "drawio" || extension === "xml") return { kind: "pages", fileName: name, format: "drawio", pages: await readDrawio(decodeText(bytes)) };
  if (["tf", "hcl", "tfstate", "json", "jsonl", "yaml", "yml", "bicep"].includes(extension)) {
    const source = decodeText(bytes);
    const inventory = readInventory(name, source, hint);
    if (inventory) return { kind: "inventory", fileName: name, inventory, source: name };
    throw new Error(
      `"${name}" is not a kind of file this can import. As infrastructure it reads Terraform (.tf, a plan or state as JSON, .tfstate), CloudFormation and SAM, ARM and Bicep, Kubernetes and OpenShift manifests, Docker Compose, a Pulumi stack export, AWS Config or Resource Explorer results, Azure Resource Graph and Google Cloud Asset Inventory results, a ServiceNow CMDB export, and BMC Helix Discovery or Device42 results.`,
    );
  }
  throw new Error(`"${name}" is not a kind of file this can import. Choose an Excel workbook (.xlsx), a CSV file, a Visio drawing (.vsdx), a draw.io file (.drawio), an ArchiMate exchange file (.xml), a Mermaid file (.mmd or .md), a Structurizr file (.dsl), or infrastructure as code (.tf, .json, .yaml, .bicep).`);
}

function Problem({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
      {text}
    </p>
  );
}

const ROLE_LABEL: Record<SheetRole, string> = { objects: "Objects, one per row", relationships: "Relationships, one per row", skip: "Nothing to import" };

function SheetCard({ sheet, mapping, onChange }: { sheet: Sheet; mapping: SheetMapping; onChange: (mapping: SheetMapping) => void }) {
  const headings = sheet.rows[0] ?? [];
  const fields = fieldsOf(mapping.role);
  const missing = fields.filter((f) => f.required && mapping.columns[f.id] == null);
  const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
  return (
    <fieldset className="rounded-md border border-line px-4 py-3" data-sheet={sheet.name}>
      <legend className="px-1 font-medium">
        {sheet.name} <span className="font-normal text-ink-soft">{countOf(sheet.rows.length - 1, "row")}</span>
      </legend>
      <Field label="This sheet holds">
        <Select value={mapping.role} onChange={(e) => onChange(remap(sheet, e.target.value as SheetRole))}>
          {(Object.keys(ROLE_LABEL) as SheetRole[]).map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </Select>
      </Field>
      {fields.length > 0 && (
        <>
          <p className="mt-3 text-[13px] text-ink-soft">Which column holds each field. The first row is read as the headings.</p>
          <div className="mt-1.5 grid sm:grid-cols-2 gap-x-4 gap-y-2">
            {fields.map((field) => (
              <label key={field.id} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-[13px] text-ink-soft">
                  {field.label}
                  {field.required && <span className="text-danger"> *</span>}
                </span>
                <Select
                  aria-label={`Column for ${field.label} in ${sheet.name}`}
                  value={mapping.columns[field.id] ?? ""}
                  onChange={(e) => onChange({ ...mapping, columns: { ...mapping.columns, [field.id]: e.target.value === "" ? null : Number(e.target.value) } })}
                >
                  <option value="">Not in this sheet</option>
                  {headings.map((heading, i) => (
                    <option key={i} value={i}>
                      {letter(i)}: {heading || "(no heading)"}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="mt-2 text-[13px] text-danger">
              Choose the column for {missing.map((f) => f.label).join(" and ")}, or set this sheet to "{ROLE_LABEL.skip}".
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}

/** Import a spreadsheet or a diagram file. The result is a draft to review, never a direct change to the model. */
export interface DiagramStart {
  name: string;
  viewType: ViewType;
  scopeId?: string | null;
}

export function ImportDialog({ onClose, start, only }: { onClose: () => void; start?: DiagramStart; only?: "drawio" }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const picker = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mappings, setMappings] = useState<SheetMapping[]>([]);
  const [fallbackType, setFallbackType] = useState("application");
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [over, setOver] = useState(false);
  const [hint, setHint] = useState<InventoryHint>(null);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem("");
    try {
      const result = await load(file, hint);
      setLoaded(result);
      if (result.kind === "sheets") setMappings(result.sheets.map(guessMapping));
      else if (result.kind === "pages") setPageIndex(Math.max(0, result.pages.findIndex((p) => p.shapes.length > 0)));
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : `"${file.name}" could not be read.`);
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void choose(event.dataTransfer.files[0]);
  };

  // What importing would do with the mapping as it stands, so the person sees it before anything is created.
  const preview = useMemo((): { proposal: Proposal; lines: string[] } | { error: string } | null => {
    if (!loaded) return null;
    try {
      if (loaded.kind === "text") return { proposal: textModelToProposal(ws, loaded.model, loaded.format, loaded.fileName), lines: [] };
      if (loaded.kind === "inventory") return { proposal: inventoryToProposal(ws, loaded.inventory, loaded.importKind ?? inventoryKind(loaded.inventory), loaded.source), lines: [] };
      if (loaded.kind === "pages") {
        const page = loaded.pages[pageIndex];
        const proposal = pageToProposal(ws, page, loaded.format, loaded.fileName);
        return { proposal, lines: [] };
      }
      const ready = mappings.every((m) => fieldsOf(m.role).every((f) => !f.required || m.columns[f.id] != null));
      if (!ready) return { error: "" };
      if (mappings.every((m) => m.role === "skip")) return { error: "Set at least one sheet to objects or relationships." };
      const { proposal, report } = sheetsToProposal(ws, loaded.sheets, mappings, loaded.fileName, fallbackType);
      return {
        proposal,
        lines: report.skipped.slice(0, 5).map((s) => `${s.sheet}, row ${s.row}: ${s.reason}`).concat(report.skippedCount > 5 ? [`and ${report.skippedCount - 5} more`] : []),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The file could not be turned into a draft." };
    }
  }, [loaded, mappings, pageIndex, fallbackType, ws]);

  const create = () => {
    if (!preview || "error" in preview) return;
    // Started from New diagram: the draft becomes a diagram of the kind and name chosen there.
    const proposal: Proposal = start
      ? { ...preview.proposal, diagramName: start.name || undefined, diagramViewType: start.viewType, ...(start.scopeId ? { diagramScopeId: start.scopeId } : {}) }
      : preview.proposal;
    apply((w) => saveProposal(w, proposal));
    onClose();
    navigate(`/ai/${proposal.id}`);
  };

  const proposal = preview && "proposal" in preview ? preview.proposal : null;
  const matched = proposal ? proposal.objects.filter((o) => o.matchId).length : 0;

  return (
    <Modal
      title={loaded ? (loaded.kind === "inventory" && loaded.importKind === "discovery" ? `Discovered in ${loaded.fileName}` : loaded.kind === "inventory" && !/\.[a-z0-9]+$/i.test(loaded.fileName) ? `From ${loaded.fileName}` : `Import "${loaded.fileName}"`) : only === "drawio" ? "Import a draw.io file" : "Import a file"}
      width={loaded?.kind === "sheets" ? 720 : 560}
      onClose={onClose}
      footer={
        <>
          {loaded && (
            <Button
              className="mr-auto"
              onClick={() => {
                setLoaded(null);
                setProblem("");
              }}
            >
              Choose another file
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          {loaded && (
            <Button variant="primary" disabled={!proposal || !canEdit} onClick={create}>
              Create draft to review
            </Button>
          )}
        </>
      }
    >
      {!loaded ? (
        <div className="space-y-4">
          <p className="text-ink-soft">The file becomes a draft. You review it, change what was guessed wrong, and accept what should be saved. Nothing is added to the model before that.</p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cx("rounded-lg border border-dashed px-5 py-6 text-center", over ? "border-blueprint bg-blueprint-soft" : "border-ink-faint")}
          >
            <Button variant="primary" icon={<FileUp size={15} />} disabled={busy} onClick={() => picker.current?.click()}>
              {busy ? "Reading the file" : "Choose a file"}
            </Button>
            <p className="mt-2 text-[13px] text-ink-soft">or drop it here. Up to 25 MB. The file is read in your browser and is not uploaded.</p>
            <input ref={picker} type="file" accept={only === "drawio" ? ".drawio,.xml" : ACCEPT} className="sr-only" aria-label="File to import" onChange={(e) => void choose(e.target.files?.[0])} />
          </div>
          {problem && <Problem text={problem} />}
          <p className="text-[13px] text-ink-soft" data-drawio-exact>
            No AI is used. In a draw.io or Visio diagram, a shape whose label or stencil is exactly a component of the library (also "Amazon S3", "AWS Lambda") becomes that component; every other
            shape is listed in the draft so you can check its type before accepting.
          </p>
          {!only && <ApmImport canEdit={canEdit} onDone={onClose} />}
          {!only && (
            <DiscoverImport
              canEdit={canEdit}
              onDone={onClose}
              onInventory={(inventory, label, kind) => {
                setProblem("");
                setLoaded({ kind: "inventory", fileName: label, inventory, source: label, importKind: kind });
              }}
            />
          )}
          <ul className="space-y-2.5">
            <li className="flex gap-3">
              <FileSpreadsheet size={18} className="mt-0.5 shrink-0 text-ink-soft" />
              <span>
                <span className="font-medium">A spreadsheet</span> (.xlsx or .csv) with one object or one relationship per row. You choose which column is which. Rows that name an
                object already in the model update it.
              </span>
            </li>
            <li className="flex gap-3">
              <Workflow size={18} className="mt-0.5 shrink-0 text-ink-soft" />
              <span>
                <span className="font-medium">A diagram</span> from Visio (.vsdx) or draw.io (.drawio). Each labelled shape becomes an object, each connector a relationship, and
                the diagram is redrawn with the boxes where they were.
              </span>
            </li>
            <li className="flex gap-3" data-import-iac>
              <Cloud size={18} className="mt-0.5 shrink-0 text-ink-soft" />
              <span>
                <span className="font-medium">Infrastructure as code:</span> Terraform (.tf, a plan or state as JSON, .tfstate), CloudFormation and SAM, ARM and Bicep, Kubernetes and OpenShift
                manifests, Docker Compose, or a Pulumi stack export. Each resource becomes a box from the library, each reference a relationship, and networks hold what sits in them.
              </span>
            </li>
            <li className="flex gap-3" data-import-discovery>
              <ScanSearch size={18} className="mt-0.5 shrink-0 text-ink-soft" />
              <span>
                <span className="font-medium">What is running:</span> AWS Config or Resource Explorer results, Azure Resource Graph or Google Cloud Asset Inventory results, a ServiceNow CMDB export
                (configuration items and relationships), or BMC Helix Discovery or Device42 results as JSON.
                <label className="mt-1 flex items-center gap-2 text-[13px] text-ink-soft">
                  Discovery rows come from
                  <Select className="!h-7 !w-auto text-[13px]" value={hint ?? ""} onChange={(e) => setHint((e.target.value || null) as InventoryHint)} aria-label="Discovery tool">
                    <option value="">Any tool</option>
                    <option value="bmc">BMC Helix Discovery</option>
                    <option value="device42">Device42</option>
                  </Select>
                </label>
              </span>
            </li>
            <li className="flex gap-3">
              <FileCode2 size={18} className="mt-0.5 shrink-0 text-ink-soft" />
              <span>
                <span className="font-medium">A diagram written as text:</span> a Mermaid flowchart or C4 diagram (.mmd, or a Markdown file that holds one) or a Structurizr workspace (.dsl). Its
                boxes, groups and arrows become objects and relationships on a new diagram.
              </span>
            </li>
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          {!canEdit && <Problem text="You have view access to this workspace, so you cannot import into it. Ask an owner for edit access." />}
          {loaded.kind === "sheets" ? (
            <>
              {!!loaded.notes?.length && (
                <div className="rounded-md border border-line bg-paper px-3 py-2 text-[13px]" data-archimate4>
                  <p className="font-medium">If you move to ArchiMate 4</p>
                  <ul className="mt-0.5 list-disc pl-5 text-ink-soft">
                    {loaded.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-ink-soft">The file is imported all the same. This only tells you what a later move would have to remodel.</p>
                </div>
              )}
              {loaded.sheets.map((sheet, i) => (
                <SheetCard key={`${sheet.name}:${i}`} sheet={sheet} mapping={mappings[i] ?? { role: "skip", columns: {} }} onChange={(next) => setMappings((all) => all.map((m, j) => (j === i ? next : m)))} />
              ))}
              {mappings.some((m) => m.role !== "skip") && (
                <Field label="Type for rows whose type is empty or not recognised" className="max-w-sm">
                  <Select value={fallbackType} onChange={(e) => setFallbackType(e.target.value)}>
                    <TypeOptions />
                  </Select>
                </Field>
              )}
            </>
          ) : loaded.kind === "inventory" ? (
            <div className="space-y-2 text-[13px]" data-import-inventory>
              <p>
                <span className="font-medium">{loaded.inventory.format}</span>
                <span className="text-ink-soft">
                  {" "}
                  with {countOf(loaded.inventory.items.length, "resource")} and {countOf(loaded.inventory.links.length, "relationship")}
                  {loaded.inventory.items.some((i) => i.typeId === "zone") ? `, networks drawn as zones` : ""}.
                </span>
              </p>
              <p className="text-ink-soft">
                {loaded.inventory.items.filter((i) => i.componentId).length} of them matched to a library component. Each resource keeps its type, address and settings as fields.
              </p>
              {loaded.inventory.skipped.length > 0 && (
                <ul className="list-disc pl-5 text-ink-soft">
                  {loaded.inventory.skipped.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : loaded.kind === "text" ? (
            <p className="text-[13px] text-ink-soft" data-import-text>
              {loaded.format === "mermaid" ? "A Mermaid diagram" : "A Structurizr workspace"} with {countOf(loaded.model.elements.length, "element")} and {countOf(loaded.model.links.length, "link")}.
            </p>
          ) : (
            <fieldset>
              <legend className="text-[13px] font-medium text-ink-soft mb-1.5">{loaded.pages.length === 1 ? "The page in this file" : "Choose the page to import. Each page becomes its own draft."}</legend>
              <div className="grid gap-1.5">
                {loaded.pages.map((page, i) => (
                  <label key={i} className={cx("flex items-start gap-2.5 rounded-md border px-3 py-2", i === pageIndex ? "border-blueprint bg-blueprint-soft/40" : "border-line", !page.shapes.length && "opacity-60")}>
                    <input type="radio" name="page" className="mt-1" checked={i === pageIndex} disabled={!page.shapes.length} onChange={() => setPageIndex(i)} />
                    <span>
                      <span className="font-medium">{page.name}</span>
                      <span className="block text-[13px] text-ink-soft">
                        {page.shapes.length ? `${countOf(page.shapes.length, "labelled shape")}, ${countOf(page.connectors.length, "connector")}` : "No labelled shapes"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {preview && "error" in preview && preview.error && <Problem text={preview.error} />}
          {proposal && (
            <div className="rounded-md bg-paper border border-line px-3.5 py-2.5 text-[13px]" data-import-summary>
              <p className="font-medium text-sm">
                The draft will hold {countOf(proposal.objects.length, "object")} and {countOf(proposal.relationships.length, "relationship")}.
              </p>
              {matched > 0 && (
                <p className="text-ink-soft">
                  {matched === proposal.objects.length ? "All of them are" : `${matched} of the objects ${matched === 1 ? "is" : "are"}`} already in the model by name and will be reused, not duplicated.
                </p>
              )}
              <p className="text-ink-soft">{proposal.notes}</p>
              {preview && "lines" in preview && preview.lines.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-ink-soft">
                  {preview.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
