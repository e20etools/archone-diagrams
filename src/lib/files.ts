import { useCallback, useEffect, useMemo, useState } from "react";
import { viewCategory } from "./categories";
import type { FileKind, FilePatch, FileUpload, StoredFile } from "./cloud/backend";
import { cloudEnabled } from "./cloud/config";
import { errorText, getBackend, useCategoryRank, useSession } from "./cloud/session";
import type { Diagram } from "./types";

/**
 * The file library: vendor documents, supporting files and designs, each linked to one or more
 * diagrams. Signed in, files are kept on the server and each person sees those they uploaded
 * and those linked to diagrams they can see. Without an account, they are kept in this browser.
 */

export type { FileKind, StoredFile };

export const FILE_KINDS: { id: FileKind; label: string; hint: string }[] = [
  { id: "vendor", label: "Vendor document", hint: "Datasheets, install and admin guides, contracts" },
  { id: "supporting", label: "Supporting file", hint: "Notes, spreadsheets, decisions, evidence" },
  { id: "design", label: "Design", hint: "Base designs, Visio, draw.io, high- and low-level designs" },
  { id: "other", label: "Other", hint: "Anything else" },
];
export const fileKindLabel = (kind: FileKind) => FILE_KINDS.find((k) => k.id === kind)?.label ?? "Other";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const LOCAL_OWNER = "this-browser";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FileStore {
  list(): Promise<StoredFile[]>;
  upload(body: Blob, upload: FileUpload): Promise<StoredFile>;
  /** An address to open the file, or to download it. */
  url(fileId: string, download?: boolean): Promise<string>;
  update(fileId: string, patch: FilePatch): Promise<void>;
  setLinks(fileId: string, diagramIds: string[]): Promise<void>;
  remove(fileId: string): Promise<void>;
}

/* ---------- in this browser ---------- */

interface LocalRecord extends StoredFile {
  body: Blob;
}

const DB_NAME = "archone-files";
function database(): Promise<IDBDatabase> {
  return new Promise((done, failed) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "id" });
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(new Error("This browser cannot keep files here. Sign in to keep them on the server."));
  });
}
async function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((done, failed) => {
    const request = run(db.transaction("files", mode).objectStore("files"));
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(new Error("The file could not be saved in this browser. It may be full."));
  });
}
const withoutBody = ({ body: _body, ...file }: LocalRecord): StoredFile => file;

export const localFiles: FileStore = {
  async list() {
    const all = await inStore<LocalRecord[]>("readonly", (s) => s.getAll() as IDBRequest<LocalRecord[]>);
    return all.map(withoutBody).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  },
  async upload(body, upload) {
    if (body.size > MAX_FILE_BYTES) throw new Error(`Files can be up to ${formatSize(MAX_FILE_BYTES)}.`);
    const at = new Date().toISOString();
    const record: LocalRecord = {
      id: `file_${Math.random().toString(36).slice(2, 10)}`,
      name: upload.name.trim().slice(0, 200) || "Untitled file",
      kind: upload.kind,
      description: upload.description.slice(0, 2000),
      mime: body.type,
      size: body.size,
      uploadedBy: LOCAL_OWNER,
      uploadedAt: at,
      updatedAt: at,
      diagramIds: [...new Set(upload.diagramIds)],
      body,
    };
    await inStore("readwrite", (s) => s.put(record));
    return withoutBody(record);
  },
  async url(fileId) {
    const record = await inStore<LocalRecord | undefined>("readonly", (s) => s.get(fileId) as IDBRequest<LocalRecord | undefined>);
    if (!record) throw new Error("That file is no longer here.");
    return URL.createObjectURL(record.body);
  },
  async update(fileId, patch) {
    const record = await inStore<LocalRecord | undefined>("readonly", (s) => s.get(fileId) as IDBRequest<LocalRecord | undefined>);
    if (!record) throw new Error("That file is no longer here.");
    await inStore("readwrite", (s) => s.put({ ...record, ...patch, name: (patch.name ?? record.name).trim() || record.name, updatedAt: new Date().toISOString() }));
  },
  async setLinks(fileId, diagramIds) {
    const record = await inStore<LocalRecord | undefined>("readonly", (s) => s.get(fileId) as IDBRequest<LocalRecord | undefined>);
    if (!record) throw new Error("That file is no longer here.");
    await inStore("readwrite", (s) => s.put({ ...record, diagramIds: [...new Set(diagramIds)], updatedAt: new Date().toISOString() }));
  },
  async remove(fileId) {
    await inStore("readwrite", (s) => s.delete(fileId));
  },
};

/* ---------- on the server ---------- */

export function cloudFiles(workspaceId: string): FileStore {
  return {
    list: async () => (await getBackend()).listFiles(workspaceId),
    upload: async (body, upload) => {
      if (body.size > MAX_FILE_BYTES) throw new Error(`Files can be up to ${formatSize(MAX_FILE_BYTES)}.`);
      return (await getBackend()).uploadFile(workspaceId, body, upload);
    },
    url: async (fileId, download) => (await getBackend()).fileUrl(workspaceId, fileId, download),
    update: async (fileId, patch) => (await getBackend()).updateFile(workspaceId, fileId, patch),
    setLinks: async (fileId, diagramIds) => (await getBackend()).setFileLinks(workspaceId, fileId, diagramIds),
    remove: async (fileId) => (await getBackend()).deleteFile(workspaceId, fileId),
  };
}

/* ---------- for pages ---------- */

export interface FileLibrary {
  files: StoredFile[] | null;
  error: string;
  refresh: () => Promise<void>;
  store: FileStore;
  /** Owners and editors upload; without an account, everyone. */
  canUpload: boolean;
  /** The uploader or an owner looks after a file. */
  canManage: (file: StoredFile) => boolean;
  /** Diagrams a file may be linked to: those this person can edit. */
  canLink: (diagram: Diagram) => boolean;
  me: string | null;
}

export function useFileLibrary(): FileLibrary {
  const workspaceId = useSession((s) => s.workspaceId);
  const role = useSession((s) => s.role);
  const me = useSession((s) => s.user?.id ?? null);
  const rank = useCategoryRank();
  const cloud = cloudEnabled && !!workspaceId;
  const store = useMemo(() => (cloud && workspaceId ? cloudFiles(workspaceId) : localFiles), [cloud, workspaceId]);
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setFiles(await store.list());
      setError("");
    } catch (e) {
      setError(errorText(e));
      setFiles((f) => f ?? []);
    }
  }, [store]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const canEdit = !cloud || role === "owner" || role === "editor";
  return {
    files,
    error,
    refresh,
    store,
    canUpload: canEdit,
    canManage: (file) => !cloud || role === "owner" || (file.uploadedBy === me && canEdit),
    canLink: (diagram) => canEdit && rank(viewCategory(diagram.viewType)) >= 3,
    me: cloud ? me : LOCAL_OWNER,
  };
}

/** Opens a file in a new tab; the tab is opened first so the browser does not block it. */
export async function openFile(store: FileStore, file: StoredFile): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const url = await store.url(file.id);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else window.location.assign(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Saves a file to the computer under its own name. */
export async function downloadFile(store: FileStore, file: StoredFile): Promise<void> {
  const url = await store.url(file.id, true);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
