import { Download, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Link2, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { personLabel } from "@/lib/cloud/collab";
import { useSession } from "@/lib/cloud/session";
import { FILE_KINDS, LOCAL_OWNER, MAX_FILE_BYTES, downloadFile, fileKindLabel, formatSize, openFile, type FileKind, type FileLibrary, type StoredFile } from "@/lib/files";
import { sortedDiagrams } from "@/lib/model";
import type { Diagram, Workspace } from "@/lib/types";
import { Badge, Button, Input, Modal, Select, Textarea, cx } from "./ui";

/** A file's icon by what it is. */
export function FileIcon({ file, size = 18 }: { file: Pick<StoredFile, "name" | "mime">; size?: number }) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.mime;
  const Icon = mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)
    ? FileImage
    : ["xlsx", "xls", "csv", "ods"].includes(ext) || mime.includes("spreadsheet")
      ? FileSpreadsheet
      : ["zip", "7z", "rar", "gz", "tar"].includes(ext)
        ? FileArchive
        : ["json", "xml", "yaml", "yml", "drawio", "vsdx", "bpmn", "puml", "mmd"].includes(ext)
          ? FileCode
          : ["pdf", "doc", "docx", "txt", "md", "pptx", "ppt", "odt"].includes(ext) || mime.startsWith("text/") || mime.includes("pdf")
            ? FileText
            : File;
  return <Icon size={size} className="shrink-0 text-ink-soft" aria-hidden />;
}

/** Ticks for the diagrams a file is linked to; those this person cannot edit stay as they are. */
export function DiagramPicker({ diagrams, value, onChange, canLink }: { diagrams: Diagram[]; value: string[]; onChange: (ids: string[]) => void; canLink: (d: Diagram) => boolean }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = diagrams.filter((d) => !q || d.name.toLowerCase().includes(q));
  return (
    <div className="rounded-md border border-line" data-file-diagrams>
      <div className="relative border-b border-line-soft">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input className="h-8 w-full bg-transparent pl-8 pr-2 text-[13px] outline-none" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a diagram" aria-label="Find a diagram to link" />
      </div>
      <ul className="max-h-44 overflow-y-auto py-1">
        {shown.map((d) => {
          const allowed = canLink(d);
          return (
            <li key={d.id}>
              <label className={cx("flex items-center gap-2 px-2.5 py-1 text-[13px]", allowed ? "cursor-pointer hover:bg-paper" : "text-ink-faint")} title={allowed ? undefined : "You cannot edit this diagram, so you cannot change its files."}>
                <input
                  type="checkbox"
                  checked={value.includes(d.id)}
                  disabled={!allowed}
                  data-link-diagram={d.id}
                  onChange={(e) => onChange(e.target.checked ? [...value, d.id] : value.filter((x) => x !== d.id))}
                />
                <span className="truncate">{d.name}</span>
              </label>
            </li>
          );
        })}
        {!shown.length && <li className="px-2.5 py-1 text-[13px] text-ink-soft">No diagram matches.</li>}
      </ul>
    </div>
  );
}

/** Choose files, say what they are and which diagrams they belong to, and upload them. */
export function UploadPanel({ library, ws, fixedDiagram, onDone }: { library: FileLibrary; ws: Workspace; fixedDiagram?: Diagram; onDone?: (count: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File[]>([]);
  const [kind, setKind] = useState<FileKind>("supporting");
  const [description, setDescription] = useState("");
  const [diagramIds, setDiagramIds] = useState<string[]>(fixedDiagram ? [fixedDiagram.id] : []);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const diagrams = useMemo(() => sortedDiagrams(ws), [ws]);
  const add = (list: FileList | null) => {
    if (!list) return;
    const files = [...list];
    const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
    setProblems(tooBig.map((f) => `${f.name} is larger than ${formatSize(MAX_FILE_BYTES)}.`));
    setChosen((c) => [...c, ...files.filter((f) => f.size <= MAX_FILE_BYTES)]);
  };
  const upload = async () => {
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const file of chosen) {
      try {
        await library.store.upload(file, { name: file.name, kind, description, diagramIds });
        done++;
      } catch (e) {
        failed.push(`${file.name}: ${e instanceof Error ? e.message : "it could not be uploaded."}`);
      }
    }
    setBusy(false);
    setProblems(failed);
    setChosen([]);
    setDescription("");
    if (input.current) input.current.value = "";
    await library.refresh();
    onDone?.(done);
  };
  return (
    <div className="space-y-3" data-file-upload>
      <div
        className={cx("rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors", dragging ? "border-blueprint bg-blueprint-soft" : "border-line bg-paper")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <Upload size={20} className="mx-auto text-ink-faint" />
        <p className="mt-1 text-[13px] text-ink-soft">
          Drop files here, or{" "}
          <button type="button" className="font-medium text-blueprint hover:underline" onClick={() => input.current?.click()}>
            choose files
          </button>
          . Up to {formatSize(MAX_FILE_BYTES)} each.
        </p>
        <input ref={input} type="file" multiple className="hidden" aria-label="Files to upload" data-file-input onChange={(e) => add(e.target.files)} />
      </div>
      {chosen.length > 0 && (
        <>
          <ul className="space-y-1" data-file-chosen={chosen.length}>
            {chosen.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-[13px]">
                <FileIcon file={{ name: f.name, mime: f.type }} size={15} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-ink-faint">{formatSize(f.size)}</span>
                <button type="button" aria-label={`Leave out ${f.name}`} onClick={() => setChosen(chosen.filter((_, j) => j !== i))}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">What it is</span>
              <Select value={kind} onChange={(e) => setKind(e.target.value as FileKind)} aria-label="Kind of file" data-file-kind>
                {FILE_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}: {k.hint}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">A note (optional)</span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Version, source, what to read first" aria-label="Note on the files" />
            </label>
          </div>
          {fixedDiagram ? (
            <p className="text-xs text-ink-soft">Linked to {fixedDiagram.name}. Link it to more diagrams later from the file library.</p>
          ) : (
            <div>
              <span className="mb-1 block text-xs text-ink-soft">Link to diagrams</span>
              <DiagramPicker diagrams={diagrams} value={diagramIds} onChange={setDiagramIds} canLink={library.canLink} />
              {!diagramIds.length && <p className="mt-1 text-xs text-signal">Not linked to a diagram, only you will see it until you link it.</p>}
            </div>
          )}
          <Button variant="primary" icon={<Upload size={14} />} onClick={() => void upload()} disabled={busy} data-file-upload-go>
            {busy ? "Uploading…" : `Upload ${chosen.length === 1 ? "the file" : `${chosen.length} files`}`}
          </Button>
        </>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-[13px] text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Who uploaded a file, as the person reading sees it. */
export function useUploaderName(): (file: StoredFile) => string {
  const people = useSession((s) => s.people);
  return (file) => (file.uploadedBy === LOCAL_OWNER ? "You" : file.uploadedBy === useSession.getState().user?.id ? "You" : personLabel(people.find((p) => p.userId === file.uploadedBy)));
}

/** The files as a table: open, download, edit, delete. */
export function FileRows({ library, ws, files, onEdit, onDelete, showLinks = true }: { library: FileLibrary; ws: Workspace; files: StoredFile[]; onEdit: (f: StoredFile) => void; onDelete: (f: StoredFile) => void; showLinks?: boolean }) {
  const uploader = useUploaderName();
  const [problem, setProblem] = useState("");
  const run = (job: Promise<void>) => job.catch((e: Error) => setProblem(e.message || "The file could not be opened."));
  return (
    <div>
      {problem && (
        <p role="alert" className="mb-2 text-[13px] text-danger">
          {problem}
        </p>
      )}
      <table className="w-full text-left text-[13px]" data-file-rows={files.length}>
        <tbody>
          {files.map((f) => {
            const linked = f.diagramIds.map((id) => ws.diagrams[id]).filter((d): d is Diagram => !!d && !d.archive?.archived);
            return (
              <tr key={f.id} className="border-b border-line-soft align-top" data-file-row={f.name}>
                <td className="py-2 pr-3">
                  <button type="button" className="flex min-w-0 items-start gap-2 text-left" onClick={() => void run(openFile(library.store, f))} data-file-open={f.name}>
                    <FileIcon file={f} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-blueprint hover:underline">{f.name}</span>
                      {f.description && <span className="block truncate text-xs text-ink-soft">{f.description}</span>}
                    </span>
                  </button>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <Badge tone={f.kind === "vendor" ? "amber" : f.kind === "design" ? "blue" : "neutral"}>{fileKindLabel(f.kind)}</Badge>
                </td>
                {showLinks && (
                  <td className="py-2 pr-3" data-file-links={linked.length}>
                    {linked.length ? (
                      <span className="flex flex-wrap gap-1">
                        {linked.map((d) => (
                          <Link key={d.id} to={`/diagram/${d.id}`} className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs hover:text-blueprint">
                            <Link2 size={10} /> {d.name}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className="text-xs text-signal">Not linked: only you see it</span>
                    )}
                  </td>
                )}
                <td className="py-2 pr-3 whitespace-nowrap text-xs text-ink-soft">{formatSize(f.size)}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-xs text-ink-soft">
                  {uploader(f)}
                  <span className="block text-ink-faint">{new Date(f.uploadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                </td>
                <td className="py-2 whitespace-nowrap text-right">
                  <button type="button" className="p-1 text-ink-soft hover:text-blueprint" aria-label={`Download ${f.name}`} onClick={() => void run(downloadFile(library.store, f))}>
                    <Download size={15} />
                  </button>
                  <button type="button" className="p-1 text-ink-soft hover:text-blueprint" aria-label={`Edit ${f.name}`} onClick={() => onEdit(f)} data-file-edit={f.name}>
                    <Pencil size={15} />
                  </button>
                  {library.canManage(f) && (
                    <button type="button" className="p-1 text-ink-soft hover:text-danger" aria-label={`Delete ${f.name}`} onClick={() => onDelete(f)} data-file-delete={f.name}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Rename a file, say what it is, and choose the diagrams it is linked to. */
export function FileEditDialog({ library, ws, file, onClose }: { library: FileLibrary; ws: Workspace; file: StoredFile; onClose: () => void }) {
  const manage = library.canManage(file);
  const [name, setName] = useState(file.name);
  const [kind, setKind] = useState<FileKind>(file.kind);
  const [description, setDescription] = useState(file.description);
  const [links, setLinks] = useState<string[]>(file.diagramIds.filter((id) => ws.diagrams[id]));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const diagrams = sortedDiagrams(ws);
  // Someone who did not upload the file may still take it off a diagram they edit.
  const canLink = (d: Diagram) => library.canLink(d) && (manage || file.diagramIds.includes(d.id));
  const save = async () => {
    setBusy(true);
    try {
      if (manage && (name.trim() !== file.name || kind !== file.kind || description !== file.description)) await library.store.update(file.id, { name: name.trim() || file.name, kind, description });
      const before = file.diagramIds.filter((id) => ws.diagrams[id]).sort().join("|");
      if (links.slice().sort().join("|") !== before) await library.store.setLinks(file.id, links);
      await library.refresh();
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The file could not be changed.");
      setBusy(false);
    }
  };
  return (
    <Modal
      title={manage ? "Edit the file" : "The file's diagrams"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy} data-file-save>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-file-edit-dialog>
        {manage ? (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="File name" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">What it is</span>
              <Select value={kind} onChange={(e) => setKind(e.target.value as FileKind)} aria-label="Kind of file">
                {FILE_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">Note</span>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} aria-label="Note" />
            </label>
          </>
        ) : (
          <p className="text-[13px] text-ink-soft">Only the person who uploaded {file.name}, or an owner, can rename it. You can take it off diagrams you edit.</p>
        )}
        <div>
          <span className="mb-1 block text-xs text-ink-soft">Linked to</span>
          <DiagramPicker diagrams={diagrams} value={links} onChange={setLinks} canLink={canLink} />
        </div>
        {problem && (
          <p role="alert" className="text-[13px] text-danger">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Deleting a file, once confirmed. */
export function DeleteFileDialog({ library, file, onClose }: { library: FileLibrary; file: StoredFile; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <Modal
      title={`Delete ${file.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            disabled={busy}
            data-file-delete-confirm
            onClick={async () => {
              setBusy(true);
              try {
                await library.store.remove(file.id);
                await library.refresh();
                onClose();
              } catch (e) {
                setProblem(e instanceof Error ? e.message : "The file could not be deleted.");
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete the file"}
          </Button>
        </>
      }
    >
      <p className="text-[13px]">
        It is removed for everyone, together with its links to {file.diagramIds.length === 1 ? "1 diagram" : `${file.diagramIds.length} diagrams`}. This cannot be undone.
      </p>
      {problem && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {problem}
        </p>
      )}
    </Modal>
  );
}
