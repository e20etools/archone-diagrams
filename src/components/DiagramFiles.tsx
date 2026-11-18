import { Link2, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useFileLibrary, type StoredFile } from "@/lib/files";
import type { Diagram, Workspace } from "@/lib/types";
import { DeleteFileDialog, FileEditDialog, FileRows, UploadPanel } from "./FileLibrary";
import { Button, Modal, Select } from "./ui";

/** The toolbar button of a diagram: how many files go with it, and the window that shows them. */
/** Asks the diagram's Files button to open its window, with the diagram's id. */
export const OPEN_FILES = "archone:open-diagram-files";

export function DiagramFilesButton({ ws, diagram }: { ws: Workspace; diagram: Diagram }) {
  const library = useFileLibrary();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = (event: Event) => (event as CustomEvent<string>).detail === diagram.id && setOpen(true);
    window.addEventListener(OPEN_FILES, on);
    return () => window.removeEventListener(OPEN_FILES, on);
  }, [diagram.id]);
  const linked = (library.files ?? []).filter((f) => f.diagramIds.includes(diagram.id));
  return (
    <>
      <Button icon={<Paperclip size={15} />} onClick={() => setOpen(true)} title="Vendor documents, supporting files and designs for this diagram" data-diagram-files-open>
        Files
        {linked.length > 0 && (
          <span className="tabular-nums text-ink-soft" data-diagram-files-count={linked.length}>
            {linked.length}
          </span>
        )}
      </Button>
      {open && <DiagramFilesDialog ws={ws} diagram={diagram} library={library} onClose={() => setOpen(false)} />}
    </>
  );
}

function DiagramFilesDialog({ ws, diagram, library, onClose }: { ws: Workspace; diagram: Diagram; library: ReturnType<typeof useFileLibrary>; onClose: () => void }) {
  const [editing, setEditing] = useState<StoredFile | null>(null);
  const [deleting, setDeleting] = useState<StoredFile | null>(null);
  const [linking, setLinking] = useState("");
  const [problem, setProblem] = useState("");
  const files = library.files ?? [];
  const linked = files.filter((f) => f.diagramIds.includes(diagram.id));
  const canLinkHere = library.canLink(diagram);
  // Files this person looks after that are not on this diagram yet.
  const linkable = files.filter((f) => !f.diagramIds.includes(diagram.id) && library.canManage(f));
  const link = async () => {
    const file = files.find((f) => f.id === linking);
    if (!file) return;
    try {
      await library.store.setLinks(file.id, [...file.diagramIds, diagram.id]);
      setLinking("");
      setProblem("");
      await library.refresh();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The file could not be linked.");
    }
  };
  return (
    <Modal title={`Files for ${diagram.name}`} onClose={onClose} width={760}>
      <div className="space-y-4" data-diagram-files>
        {library.error && (
          <p role="alert" className="text-[13px] text-danger">
            {library.error}
          </p>
        )}
        {library.files === null ? (
          <p className="text-[13px] text-ink-soft">Loading the files…</p>
        ) : linked.length ? (
          <FileRows library={library} ws={ws} files={linked} onEdit={setEditing} onDelete={setDeleting} showLinks={false} />
        ) : (
          <p className="text-[13px] text-ink-soft">No files go with this diagram yet.</p>
        )}
        {library.canUpload && canLinkHere && (
          <section className="rounded-lg border border-line px-3 py-3">
            <h3 className="mb-2 text-[13px] font-semibold">Upload for this diagram</h3>
            <UploadPanel library={library} ws={ws} fixedDiagram={diagram} />
          </section>
        )}
        {canLinkHere && linkable.length > 0 && (
          <section className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-ink-soft">Or link a file already in the library:</span>
            <Select className="h-8 w-72" value={linking} onChange={(e) => setLinking(e.target.value)} aria-label="File to link" data-diagram-files-link>
              <option value="">Choose a file</option>
              {linkable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <Button size="sm" icon={<Link2 size={13} />} disabled={!linking} onClick={() => void link()} data-diagram-files-link-go>
              Link
            </Button>
          </section>
        )}
        {problem && (
          <p role="alert" className="text-[13px] text-danger">
            {problem}
          </p>
        )}
        <p className="text-xs text-ink-faint">
          <Link to={`/files?diagram=${diagram.id}`} className="text-blueprint hover:underline">
            Open the file library
          </Link>{" "}
          to link files to several diagrams, rename or delete them.
        </p>
      </div>
      {editing && <FileEditDialog library={library} ws={ws} file={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteFileDialog library={library} file={deleting} onClose={() => setDeleting(null)} />}
    </Modal>
  );
}
