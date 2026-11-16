import { ExternalLink, Shapes } from "lucide-react";
import { useState } from "react";
import { LibraryIcon } from "@/components/icons";
import { LibraryPanel } from "@/components/LibraryBrowser";
import { Button, CommitInput, Field, Input, Modal, Select } from "@/components/ui";
import { objectType } from "@/lib/catalog";
import { componentLabel, componentOf, profileOf, sectionById } from "@/lib/library";
import type { ProfileField } from "@/lib/library/profiles";
import { safeUrl } from "@/lib/links";
import { updateObject } from "@/lib/model";
import { apply } from "@/lib/store";
import type { ModelObject } from "@/lib/types";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f:]+(\/\d{1,3})?$/i;

/** Whether a value fits its field. A wrong one is kept, and marked, so nothing typed is lost. */
export function fieldProblem(field: ProfileField, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (field.kind === "number" && !/^-?\d+([.,]\d+)?$/.test(v)) return "A number";
  if (field.kind === "ip" && !(IPV4.test(v) || (v.includes(":") && IPV6.test(v)))) return "An IP address";
  if (field.kind === "url" && !safeUrl(v)) return "A web address";
  if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "A date";
  return null;
}

function FieldInput({ field, value, onChange }: { field: ProfileField; value: string; onChange: (value: string) => void }) {
  const problem = fieldProblem(field, value);
  const label = field.unit ? `${field.label} (${field.unit})` : field.label;
  if (field.kind === "select") {
    return (
      <Field label={label}>
        <Select aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not set</option>
          {value && !field.options!.includes(value) && <option value={value}>{value}</option>}
          {field.options!.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      </Field>
    );
  }
  if (field.kind === "date") {
    return (
      <Field label={label}>
        <Input type="date" aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!problem} />
      </Field>
    );
  }
  const safe = field.kind === "url" ? safeUrl(value) : null;
  return (
    <Field label={label} hint={problem ? `${problem} is expected here.` : undefined}>
      <div className="flex items-center gap-1">
        <CommitInput
          aria-label={field.label}
          value={value}
          placeholder={field.placeholder}
          inputMode={field.kind === "number" ? "decimal" : field.kind === "url" ? "url" : undefined}
          aria-invalid={!!problem}
          onCommit={onChange}
        />
        {safe && (
          <a href={safe} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blueprint" title={`Open ${safe}`} aria-label={`Open ${field.label}`}>
            <ExternalLink size={15} />
          </a>
        )}
      </div>
    </Field>
  );
}

/**
 * The basic information of one object, asked for according to what it is: a server's host
 * name and serial number, a database's engine and recovery point, a cloud service's region.
 * Each answer is a field of the object, under the field's label.
 */
export function BasicInformation({ object, readOnly = false }: { object: ModelObject; readOnly?: boolean }) {
  const profile = profileOf(object);
  const set = (label: string, value: string) => {
    const { [label]: _old, ...rest } = object.fields;
    apply((w) => updateObject(w, object.id, { fields: value.trim() ? { ...rest, [label]: value.trim() } : rest }));
  };
  const filled = profile.fields.filter((f) => (object.fields[f.label] ?? "").trim()).length;
  return (
    <fieldset data-basic-information={profile.id}>
      <legend className="flex w-full items-baseline justify-between text-[13px] font-medium text-ink-soft mb-1">
        <span>Basic information: {profile.label.toLowerCase()}</span>
        <span className="text-xs text-ink-faint tabular-nums">
          {filled} of {profile.fields.length}
        </span>
      </legend>
      {readOnly ? (
        <dl className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 text-[13px]">
          {profile.fields
            .filter((f) => object.fields[f.label])
            .map((f) => (
              <div key={f.label}>
                <dt className="text-ink-soft">{f.label}</dt>
                <dd>
                  {object.fields[f.label]}
                  {f.unit ? ` ${f.unit}` : ""}
                </dd>
              </div>
            ))}
        </dl>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {profile.fields.map((f) => (
            <FieldInput key={f.label} field={f} value={object.fields[f.label] ?? ""} onChange={(v) => set(f.label, v)} />
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Which library component an object is, with a way to choose another or none. */
export function ComponentField({ object }: { object: ModelObject }) {
  const [open, setOpen] = useState(false);
  const component = componentOf(object);
  const section = component ? sectionById(component.sectionId) : undefined;
  return (
    <Field label="Component" hint={component ? `${section?.label}. Drawn as a ${objectType(component.kind).label.toLowerCase()} in the model.` : "Not from the library. Choose one for its icon and the right basic information."}>
      <div className="flex items-center gap-1.5" data-component-field={component?.id ?? ""}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 h-9 px-2.5 rounded-md border border-line bg-paper text-sm">
          {component ? (
            <>
              <span style={{ color: section?.color }}>
                <LibraryIcon name={component.icon} size={15} />
              </span>
              <span className="truncate">{componentLabel(component)}</span>
            </>
          ) : (
            <span className="text-ink-faint">None</span>
          )}
        </span>
        <Button size="sm" className="!h-9" icon={<Shapes size={14} />} onClick={() => setOpen(true)}>
          {component ? "Change" : "Choose"}
        </Button>
      </div>
      {open && (
        <Modal
          title={`What is "${object.name}"?`}
          onClose={() => setOpen(false)}
          width={520}
          footer={
            <>
              {component && (
                <Button
                  onClick={() => {
                    apply((w) => updateObject(w, object.id, { componentId: undefined }));
                    setOpen(false);
                  }}
                >
                  Not from the library
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </>
          }
        >
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <LibraryPanel
              intro={<p className="text-[13px] text-ink-soft">Choosing a component gives the object its icon and its basic information. Its type changes to the component's, and what is filled in already is kept.</p>}
              onPick={(c) => {
                apply((w) => updateObject(w, object.id, { componentId: c.id, typeId: c.kind }));
                setOpen(false);
              }}
            />
          </div>
        </Modal>
      )}
    </Field>
  );
}
