import { ArrowLeft, History, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ComparisonList, VersionDiagrams, useVersionTables } from "@/components/cloud/ComparisonView";
import { Badge, Button, EmptyState, Field, IconButton, Input, Modal, Select, Tabs, Textarea, countOf, formatDateTime, useNotice } from "@/components/ui";
import { VERSION_KIND_LABEL, personLabel, type VersionInfo } from "@/lib/cloud/collab";
import { deleteVersion, errorText, revertToVersion, saveVersion, useCanEdit, useSession } from "@/lib/cloud/session";
import { toTables } from "@/lib/cloud/tables";
import { useWorkspace } from "@/lib/store";

const holds = (v: VersionInfo) => `${countOf(v.objects, "object")}, ${countOf(v.relationships, "relationship")}, ${countOf(v.diagrams, "diagram")}`;

function useNames() {
  const people = useSession((s) => s.people);
  return (userId: string | null) => personLabel(people.find((p) => p.userId === userId));
}

export function VersionBadges({ version }: { version: VersionInfo }) {
  const published = useSession((s) => s.review.publishedVersionId);
  const inReview = useSession((s) => s.reviews.some((r) => r.status === "open" && r.versionId === version.id));
  return (
    <span className="inline-flex gap-1.5">
      {version.id === published && <Badge tone="green">Published</Badge>}
      {inReview && <Badge tone="amber">In review</Badge>}
      {version.kind !== "manual" && <Badge>{VERSION_KIND_LABEL[version.kind]}</Badge>}
    </span>
  );
}

function SaveVersionDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const save = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setProblem("");
    saveVersion(name, note).then(onSaved, (e) => {
      setProblem(errorText(e));
      setBusy(false);
    });
  };
  return (
    <Modal
      title="Save a version"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={save}>
            {busy ? "Saving" : "Save version"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-ink-soft">A version is a copy of the whole model as it is now. You can compare with it later, or go back to it.</p>
        <Field label="Name">
          <Input value={name} maxLength={120} placeholder="For example: Before the payments migration" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        </Field>
        <Field label="Note" hint="Optional. What this version is for.">
          <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

function RevertDialog({ version, onClose, onDone }: { version: VersionInfo; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <Modal
      title={`Go back to "${version.name}"?`}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              revertToVersion(version).then(onDone, (e) => {
                setProblem(errorText(e));
                setBusy(false);
              });
            }}
          >
            {busy ? "Reverting" : "Revert the model"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <p>
          The working model becomes what it was in this version ({holds(version)}), for every member. Everything changed since then is replaced. AI drafts and comments stay.
        </p>
        <p className="text-ink-soft">The model as it is now is saved as a version first, so you can take this back.</p>
        {problem && (
          <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function VersionsPage() {
  const versions = useSession((s) => s.versions);
  const role = useSession((s) => s.role);
  const published = useSession((s) => s.published);
  const canEdit = useCanEdit();
  const nameOf = useNames();
  const { notify, view: notice } = useNotice();
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState<VersionInfo | null>(null);
  const [removing, setRemoving] = useState<VersionInfo | null>(null);
  const [problem, setProblem] = useState("");

  return (
    <div className="max-w-4xl mx-auto px-6 py-7">
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold">Versions</h1>
          <p className="text-ink-soft mt-0.5">
            {published
              ? "With review switched on, you see the published version. Earlier versions are open to owners and editors."
              : "Copies of the whole model at a moment in time. Open one to see its diagrams and what has changed since."}
          </p>
        </div>
        {canEdit && (
          <Button variant="primary" className="ml-auto" icon={<History size={15} />} onClick={() => setSaving(true)}>
            Save a version
          </Button>
        )}
      </div>

      {problem && (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      {versions.length === 0 ? (
        <EmptyState
          title="No versions yet"
          text={canEdit ? "Save one before a large change, so you can compare with it or go back." : "Owners and editors save versions. None has been saved in this workspace."}
        >
          {canEdit && (
            <Button variant="primary" onClick={() => setSaving(true)}>
              Save a version
            </Button>
          )}
        </EmptyState>
      ) : (
        <table className="mt-5 w-full text-left rounded-lg border border-line bg-surface border-separate border-spacing-0 overflow-hidden">
          <thead className="text-[13px] text-ink-soft">
            <tr>
              <th className="font-medium px-4 py-2 border-b border-line">Version</th>
              <th className="font-medium px-4 py-2 border-b border-line w-52">Saved</th>
              <th className="px-4 py-2 border-b border-line w-24">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-2.5 border-b border-line-soft align-top">
                  <Link to={`/versions/${v.id}`} className="font-medium text-blueprint hover:underline">
                    {v.name}
                  </Link>
                  <span className="ml-2 align-middle">
                    <VersionBadges version={v} />
                  </span>
                  <span className="block text-[13px] text-ink-soft">
                    {holds(v)}
                    {v.note && `. ${v.note}`}
                  </span>
                </td>
                <td className="px-4 py-2.5 border-b border-line-soft align-top text-[13px] text-ink-soft">
                  {formatDateTime(v.createdAt)}
                  <span className="block">by {nameOf(v.createdBy)}</span>
                </td>
                <td className="px-2 py-1.5 border-b border-line-soft align-top text-right whitespace-nowrap">
                  {role === "owner" && (
                    <>
                      <IconButton label={`Revert the model to ${v.name}`} onClick={() => setReverting(v)}>
                        <RotateCcw size={15} />
                      </IconButton>
                      <IconButton label={`Delete the version ${v.name}`} onClick={() => setRemoving(v)}>
                        <Trash2 size={15} />
                      </IconButton>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {saving && (
        <SaveVersionDialog
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            notify("Version saved.");
          }}
        />
      )}
      {reverting && (
        <RevertDialog
          version={reverting}
          onClose={() => setReverting(null)}
          onDone={() => {
            setReverting(null);
            notify("Model reverted.");
          }}
        />
      )}
      {removing && (
        <Modal
          title={`Delete the version "${removing.name}"?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  setProblem("");
                  deleteVersion(target.id).then(
                    () => notify("Version deleted."),
                    (e) => setProblem(errorText(e)),
                  );
                }}
              >
                Delete version
              </Button>
            </>
          }
        >
          <p>This copy of the model is removed for everyone and cannot be brought back. The working model is not affected.</p>
        </Modal>
      )}
      {notice}
    </div>
  );
}

export function VersionPage() {
  const { id = "" } = useParams();
  const versions = useSession((s) => s.versions);
  const role = useSession((s) => s.role);
  const published = useSession((s) => s.published);
  const ws = useWorkspace();
  const nameOf = useNames();
  const { notify, view: notice } = useNotice();
  const version = versions.find((v) => v.id === id);
  const [tab, setTab] = useState<"changes" | "diagrams">("changes");
  // Compared with the model on screen by default: the working model, or for readers the published version.
  const [against, setAgainst] = useState("now");
  const [reverting, setReverting] = useState(false);
  const { tables, problem } = useVersionTables(version ? id : null);
  const other = useVersionTables(against === "now" ? null : against);
  const now = useMemo(() => toTables(ws), [ws]);

  if (!version) {
    return (
      <EmptyState title="This version cannot be opened" text="It may have been deleted, or you may not have access to it.">
        <Link to="/versions" className="font-medium text-blueprint hover:underline">
          Go to versions
        </Link>
      </EmptyState>
    );
  }
  const nowLabel = published ? "The published version" : "The working model now";
  const target = against === "now" ? now : other.tables;
  const others = versions.filter((v) => v.id !== version.id);

  return (
    <div className="max-w-4xl mx-auto px-6 py-7">
      <Link to="/versions" className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink">
        <ArrowLeft size={14} /> Versions
      </Link>
      <div className="mt-2 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold break-words">
            {version.name}{" "}
            <span className="align-middle">
              <VersionBadges version={version} />
            </span>
          </h1>
          <p className="text-ink-soft mt-0.5">
            Saved {formatDateTime(version.createdAt)} by {nameOf(version.createdBy)}. {holds(version)}.
          </p>
          {version.note && <p className="mt-1 whitespace-pre-wrap">{version.note}</p>}
        </div>
        {role === "owner" && (
          <Button className="ml-auto" icon={<RotateCcw size={15} />} onClick={() => setReverting(true)}>
            Revert the model to this
          </Button>
        )}
      </div>

      <div className="mt-5">
        <Tabs
          tabs={[
            { id: "changes", label: "What changed" },
            { id: "diagrams", label: "Diagrams", count: version.diagrams },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {problem ? (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      ) : !tables ? (
        <p className="mt-4 text-ink-soft">Opening the version.</p>
      ) : tab === "diagrams" ? (
        <div className="mt-4">
          <VersionDiagrams tables={tables} name={version.name} />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-line bg-surface px-5 py-4">
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink-soft">
            From this version to
            <Select className="!w-80" aria-label="Compare with" value={against} onChange={(e) => setAgainst(e.target.value)}>
              <option value="now">{nowLabel}</option>
              {others.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({formatDateTime(v.createdAt)})
                </option>
              ))}
            </Select>
          </label>
          <div className="mt-3">
            {other.problem ? (
              <p role="alert" className="text-danger">
                {other.problem}
              </p>
            ) : !target ? (
              <p className="text-ink-soft">Comparing.</p>
            ) : (
              <ComparisonList before={tables} after={target} emptyText="Nothing differs between the two." />
            )}
          </div>
        </div>
      )}

      {reverting && (
        <RevertDialog
          version={version}
          onClose={() => setReverting(false)}
          onDone={() => {
            setReverting(false);
            notify("Model reverted.");
          }}
        />
      )}
      {notice}
    </div>
  );
}
