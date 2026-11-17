import { FolderOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DeleteFileDialog, FileEditDialog, FileRows, UploadPanel } from "@/components/FileLibrary";
import { Input, Select } from "@/components/ui";
import { cloudEnabled } from "@/lib/cloud/config";
import { FILE_KINDS, formatSize, useFileLibrary, type FileKind, type StoredFile } from "@/lib/files";
import { sortedDiagrams } from "@/lib/model";
import { useWorkspace } from "@/lib/store";

/**
 * The file library: vendor documents, supporting files and designs, each linked to the diagrams
 * it belongs to. Upload, link, unlink, rename and delete here; open them from a diagram too.
 */
export function FilesPage() {
  const ws = useWorkspace();
  const library = useFileLibrary();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind | "">("");
  const [mine, setMine] = useState(false);
  const diagram = params.get("diagram") ?? "";
  const [editing, setEditing] = useState<StoredFile | null>(null);
  const [deleting, setDeleting] = useState<StoredFile | null>(null);
  const diagrams = useMemo(() => sortedDiagrams(ws), [ws]);
  const q = query.trim().toLowerCase();
  const files = (library.files ?? []).filter(
    (f) =>
      (!q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)) &&
      (!kind || f.kind === kind) &&
      (!diagram || (diagram === "none" ? !f.diagramIds.some((id) => ws.diagrams[id]) : f.diagramIds.includes(diagram))) &&
      (!mine || f.uploadedBy === library.me),
  );
  const total = (library.files ?? []).reduce((n, f) => n + f.size, 0);
  return (
    <div className="max-w-6xl mx-auto px-6 py-6" data-files-page>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold">File library</h1>
          <p className="text-ink-soft mt-0.5 max-w-3xl">
            Vendor documents, supporting files and designs, linked to the diagrams they belong to.{" "}
            {cloudEnabled ? "You see the files you uploaded and those linked to diagrams you can open." : "Files are kept in this browser."}
          </p>
        </div>
        {library.files && (
          <p className="ml-auto text-[13px] text-ink-soft" data-files-total={library.files.length}>
            {library.files.length} {library.files.length === 1 ? "file" : "files"}, {formatSize(total)}
          </p>
        )}
      </div>

      {library.canUpload && (
        <section className="mt-4 rounded-lg border border-line bg-surface px-4 py-4">
          <h2 className="mb-2 text-sm font-semibold">Upload</h2>
          <UploadPanel library={library} ws={ws} />
        </section>
      )}

      <section className="mt-4 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
          <div className="relative w-64">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <Input className="pl-8 h-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a file" aria-label="Find a file" />
          </div>
          <Select className="h-8 w-48" value={kind} onChange={(e) => setKind(e.target.value as FileKind | "")} aria-label="Kind of file">
            <option value="">Every kind</option>
            {FILE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </Select>
          <Select className="h-8 w-56" value={diagram} onChange={(e) => setParams(e.target.value ? { diagram: e.target.value } : {})} aria-label="Diagram" data-files-diagram-filter>
            <option value="">Every diagram</option>
            <option value="none">Not linked to a diagram</option>
            {diagrams.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-[13px] text-ink-soft">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Uploaded by me
          </label>
        </div>
        <div className="px-4 py-2">
          {library.error && (
            <p role="alert" className="py-2 text-[13px] text-danger">
              {library.error}
            </p>
          )}
          {library.files === null ? (
            <p className="py-6 text-center text-[13px] text-ink-soft">Loading the files…</p>
          ) : !library.files.length ? (
            <div className="py-10 text-center text-ink-soft">
              <FolderOpen size={26} className="mx-auto text-ink-faint" />
              <p className="mt-2 text-[13px]">No files yet. {library.canUpload ? "Upload the vendor guides, designs and notes that go with your diagrams." : "Files linked to diagrams you can open will show here."}</p>
            </div>
          ) : !files.length ? (
            <p className="py-6 text-center text-[13px] text-ink-soft">No file matches.</p>
          ) : (
            <FileRows library={library} ws={ws} files={files} onEdit={setEditing} onDelete={setDeleting} />
          )}
        </div>
      </section>
      {editing && <FileEditDialog library={library} ws={ws} file={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteFileDialog library={library} file={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
