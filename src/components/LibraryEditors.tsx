import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { LibraryIcon } from "@/components/icons";
import { LIBRARY_ICONS } from "@/components/libraryIcons";
import { Button, Field, Input, Modal, Select, Textarea, cx } from "@/components/ui";
import { OBJECT_TYPES } from "@/lib/catalog";
import { LIBRARY_SECTIONS, PROVIDERS, builtInComponent, sectionById, type LibraryComponent } from "@/lib/library";
import { PROFILES } from "@/lib/library/profiles";
import { PROTOCOL_GROUPS, isBuiltInProtocol, type ProtocolInfo, type Transport } from "@/lib/library/protocols";
import { componentUsers, protocolUsers, renameOnConnections, saveComponent, saveProtocol, type ComponentInput, type ProtocolInput } from "@/lib/libraryEdits";
import { apply, useStore } from "@/lib/store";
import type { Workspace } from "@/lib/types";

const ICON_NAMES = Object.keys(LIBRARY_ICONS).sort();
const TRANSPORTS: Transport[] = ["TCP", "UDP", "TCP/UDP", "IP", "Other"];

/** Picks one of the library's icons by searching its name. */
function IconPicker({ value, onChange, color }: { value: string; onChange: (name: string) => void; color: string }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ICON_NAMES.filter((n) => words.every((w) => n.toLowerCase().includes(w))).slice(0, 96);
  return (
    <div data-icon-picker>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
        <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${ICON_NAMES.length} icons, e.g. shield, cloud`} aria-label="Search icons" />
      </div>
      <div className="mt-2 grid max-h-40 grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1 overflow-y-auto rounded-md border border-line-soft p-1.5" role="listbox" aria-label="Icon">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={value === name}
            title={name}
            data-icon={name}
            onClick={() => onChange(name)}
            className={cx("grid size-9 place-items-center rounded-md border", value === name ? "border-blueprint bg-blueprint-soft" : "border-transparent hover:border-line")}
            style={{ color }}
          >
            <LibraryIcon name={name} size={18} />
          </button>
        ))}
        {!shown.length && <p className="col-span-full px-1 py-2 text-xs text-ink-faint">No icon has that name.</p>}
      </div>
    </div>
  );
}

/**
 * Makes or changes a component of the library: its name, section, what it is in the model, its
 * icon, the basic information it asks for, and other names to find it by. A change to a
 * built-in one is kept for this workspace only.
 */
export function ComponentDialog({ ws, component, onClose, onSaved }: { ws: Workspace; component?: LibraryComponent; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState<ComponentInput>(() =>
    component
      ? { name: component.name, sectionId: component.sectionId, kind: component.kind, icon: component.icon, profile: component.profile, aliases: component.aliases, provider: component.provider }
      : { name: "", sectionId: "applications", kind: "application", icon: "AppWindow", profile: "application", aliases: "" },
  );
  const set = (patch: Partial<ComponentInput>) => setForm((f) => ({ ...f, ...patch }));
  const section = sectionById(form.sectionId);
  const builtIn = component && builtInComponent(component.id);
  const users = component ? componentUsers(ws, component.id).length : 0;
  const general = LIBRARY_SECTIONS.filter((s) => !s.provider);
  const save = () => {
    let id = "";
    apply((w) => {
      const saved = saveComponent(w, { ...form, provider: section?.provider }, component?.id);
      id = saved.id;
      return saved.ws;
    });
    if (id && useStore.getState().ws.library[id]) onSaved(id);
  };
  return (
    <Modal
      title={component ? `Edit ${component.name}` : "New component"}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!form.name.trim()} data-component-save>
            {component ? "Save changes" : "Add to the library"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-component-dialog>
        <Field label="Name" className="sm:col-span-2">
          <Input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="For example: Core ledger" aria-label="Component name" maxLength={120} />
        </Field>
        <Field label="Section">
          <Select value={form.sectionId} onChange={(e) => set({ sectionId: e.target.value })} aria-label="Section">
            <optgroup label="General">
              {general.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            {PROVIDERS.map((p) => (
              <optgroup key={p.id} label={p.label}>
                {LIBRARY_SECTIONS.filter((s) => s.provider === p.id).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.group}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="In the model it is a">
          <Select value={form.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Object type">
            {OBJECT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Basic information it asks for">
          <Select value={form.profile} onChange={(e) => set({ profile: e.target.value })} aria-label="Basic information">
            {PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Other names to find it by" hint="Short forms, product names, words people search for">
          <Input value={form.aliases} onChange={(e) => set({ aliases: e.target.value })} placeholder="GL, general ledger" aria-label="Other names" maxLength={400} />
        </Field>
        <div className="sm:col-span-2">
          <span className="mb-1 flex items-center gap-2 text-[13px] font-medium text-ink-soft">
            Icon
            <span className="inline-flex items-center gap-1 text-ink-faint font-normal" style={{ color: section?.color }}>
              <LibraryIcon name={form.icon} size={16} /> {form.icon}
            </span>
          </span>
          <IconPicker value={form.icon} onChange={(icon) => set({ icon })} color={section?.color ?? "#2447D6"} />
        </div>
      </div>
      {component && (
        <p className="mt-3 text-xs text-ink-faint">
          {builtIn ? "This changes the built-in component for this workspace only; Back to built-in undoes it. " : ""}
          {users ? `${users} ${users === 1 ? "object is" : "objects are"} this component and will show the change.` : ""}
        </p>
      )}
    </Modal>
  );
}

/** Makes or changes a protocol: name, port, transport, group, whether it encrypts, and what it is for. */
export function ProtocolDialog({ ws, protocol, onClose }: { ws: Workspace; protocol?: ProtocolInfo; onClose: () => void }) {
  const [form, setForm] = useState<ProtocolInput>(() =>
    protocol ? { name: protocol.name, port: protocol.port, transport: protocol.transport, group: protocol.group, secure: protocol.secure, use: protocol.use } : { name: "", port: "", transport: "TCP", group: "Your own", secure: true, use: "" },
  );
  const set = (patch: Partial<ProtocolInput>) => setForm((f) => ({ ...f, ...patch }));
  const users = useMemo(() => (protocol ? protocolUsers(ws, protocol.name) : 0), [ws, protocol]);
  const renamed = !!protocol && (form.name.trim().toLowerCase() !== protocol.name.toLowerCase() || form.port.trim() !== protocol.port);
  const [follow, setFollow] = useState(true);
  const save = () => {
    apply((w) => {
      const saved = saveProtocol(w, form, protocol?.id).ws;
      return protocol && renamed && follow ? renameOnConnections(saved, protocol, { name: form.name.trim(), port: form.port.trim(), transport: form.transport }) : saved;
    });
    onClose();
  };
  return (
    <Modal
      title={protocol ? `Edit ${protocol.name}` : "New protocol"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!form.name.trim()} data-protocol-save>
            {protocol ? "Save changes" : "Add the protocol"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3" data-protocol-dialog>
        <Field label="Name" className="sm:col-span-2">
          <Input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="For example: ISO 8583" aria-label="Protocol name" maxLength={60} />
        </Field>
        <Field label="Port">
          <Input value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="443, 8000-8100" aria-label="Protocol port" maxLength={40} />
        </Field>
        <Field label="Transport">
          <Select value={form.transport} onChange={(e) => set({ transport: e.target.value as Transport })} aria-label="Transport">
            {TRANSPORTS.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Group" className="sm:col-span-2">
          <Input list="protocol-groups" value={form.group} onChange={(e) => set({ group: e.target.value })} aria-label="Protocol group" maxLength={60} />
          <datalist id="protocol-groups">
            {PROTOCOL_GROUPS.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>
        <Field label="What it is for" className="sm:col-span-3">
          <Textarea rows={2} value={form.use} onChange={(e) => set({ use: e.target.value })} aria-label="What it is for" maxLength={300} />
        </Field>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-3">
          <input type="checkbox" checked={form.secure} onChange={(e) => set({ secure: e.target.checked })} data-protocol-secure />
          It encrypts what it carries (the checks then count it as safe)
        </label>
        {renamed && users > 0 && (
          <label className="flex items-center gap-2 text-[13px] sm:col-span-3" data-protocol-follow>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Also change it on the {users} {users === 1 ? "connection" : "connections"} that carry {protocol!.name}
          </label>
        )}
      </div>
      {protocol && isBuiltInProtocol(protocol.id) && <p className="mt-3 text-xs text-ink-faint">This changes the built-in protocol for this workspace only; Back to built-in undoes it.</p>}
    </Modal>
  );
}

/** Asks before a component or protocol leaves the library, saying what keeps working. */
export function RemoveFromLibrary({ name, builtIn, users, what, onConfirm, onClose }: { name: string; builtIn: boolean; users: number; what: "component" | "protocol"; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title={builtIn ? `Remove ${name} from the library?` : `Delete ${name}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" onClick={onConfirm} data-library-remove-confirm>
            {builtIn ? "Remove" : "Delete"}
          </Button>
        </>
      }
    >
      <p className="text-[13px]">
        {builtIn
          ? `It is hidden from this workspace's library. You can put it back from "Removed" at any time.`
          : `It is deleted from this workspace's library.`}{" "}
        {what === "component"
          ? users
            ? `${users} ${users === 1 ? "object is" : "objects are"} this component; ${users === 1 ? "it stays" : "they stay"} in the model and on diagrams, drawn as ${users === 1 ? "its" : "their"} type.`
            : "No object in this model is this component."
          : users
            ? `${users} ${users === 1 ? "connection carries" : "connections carry"} it and keep it as written.`
            : "No connection carries it."}
      </p>
    </Modal>
  );
}
