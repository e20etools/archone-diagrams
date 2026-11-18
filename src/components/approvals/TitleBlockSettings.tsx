import { ImageUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button, CommitInput, Field, Select } from "@/components/ui";
import { FIELD_LABEL } from "@/lib/approvals";
import { formatSize } from "@/lib/files";
import { TITLE_BLOCK_CORNERS, TITLE_BLOCK_FIELD_IDS, type Diagram, type TitleBlock, type Workspace } from "@/lib/types";

export const LOGO_LIMIT = 200 * 1024;

/** Reads a small image into a data URL, or says why it cannot be used. */
export function readLogoFile(file: File | undefined, done: (dataUrl: string) => void, problem: (text: string) => void) {
  problem("");
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)) return problem("Choose a PNG, JPEG, WebP, SVG or GIF image.");
  if (file.size > LOGO_LIMIT) return problem(`The logo can be up to ${formatSize(LOGO_LIMIT)}. A small square image works best.`);
  const reader = new FileReader();
  reader.onload = () => done(String(reader.result));
  reader.readAsDataURL(file);
}

export const CORNER_LABEL: Record<(typeof TITLE_BLOCK_CORNERS)[number], string> = {
  "bottom-right": "Bottom right",
  "bottom-left": "Bottom left",
  "top-right": "Top right",
  "top-left": "Top left",
};

/** A diagram's own settings for its information box: shown or not, where, its company, and the fields it leaves out. */
export function TitleBlockSettings({ ws, diagram, canEdit, onChange }: { ws: Workspace; diagram: Diagram; canEdit: boolean; onChange: (titleBlock: TitleBlock) => void }) {
  const branding = ws.branding?.workspace;
  const box: TitleBlock = diagram.titleBlock ?? { show: false, corner: "bottom-right" };
  const required = new Set(branding?.boxFields ?? []);
  const hidden = new Set(box.hidden ?? []);
  const forced = !!branding?.boxRequired;
  const [problem, setProblem] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<TitleBlock>) => onChange({ ...box, ...patch });
  return (
    <fieldset disabled={!canEdit} className="space-y-3" data-title-block-settings>
      <label className="flex items-start gap-2 text-[13px] cursor-pointer">
        <input type="checkbox" className="accent-blueprint mt-0.5" checked={box.show || forced} disabled={forced} onChange={(e) => change({ show: e.target.checked })} data-title-block-show />
        <span>
          Show the information box on this diagram
          <span className="block text-xs text-ink-faint">{forced ? "Every diagram in this workspace shows it." : "Also on live links, verified copies and exported pictures."}</span>
        </span>
      </label>
      {(box.show || forced) && (
        <>
          <Field label="Corner">
            <Select value={box.corner ?? "bottom-right"} onChange={(e) => change({ corner: e.target.value as TitleBlock["corner"] })} aria-label="Corner of the information box">
              {TITLE_BLOCK_CORNERS.map((c) => (
                <option key={c} value={c}>
                  {CORNER_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Company" hint="Leave empty to use the workspace's company, set in Settings.">
            <CommitInput value={box.company ?? ""} maxLength={120} placeholder={branding?.company || ws.name} onCommit={(company) => change({ company: company.trim() || undefined })} aria-label="Company of this diagram" />
          </Field>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">Company logo</span>
            <div className="flex items-center gap-2">
              <span className="grid size-10 place-items-center rounded-md border border-line bg-paper">
                {box.logo || branding?.companyLogo ? <img src={box.logo || branding?.companyLogo} alt="The company logo" className="size-8 object-contain" /> : <ImageUp size={16} className="text-ink-faint" />}
              </span>
              <Button size="sm" icon={<ImageUp size={13} />} onClick={() => file.current?.click()}>
                {box.logo ? "Change" : "Use another logo"}
              </Button>
              {box.logo && (
                <Button size="sm" icon={<Trash2 size={13} />} onClick={() => change({ logo: undefined })}>
                  Remove
                </Button>
              )}
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                className="sr-only"
                aria-label="Logo of this diagram's company"
                onChange={(e) => readLogoFile(e.target.files?.[0], (logo) => change({ logo }), setProblem)}
              />
            </div>
            {problem && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {problem}
              </p>
            )}
          </div>
          <div>
            <span className="mb-1 block text-xs text-ink-soft">What the box shows</span>
            <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
              {TITLE_BLOCK_FIELD_IDS.map((f) => (
                <li key={f}>
                  <label className="flex items-center gap-1.5 text-[13px] cursor-pointer" title={required.has(f) ? "The workspace requires this field" : undefined}>
                    <input
                      type="checkbox"
                      className="accent-blueprint"
                      checked={required.has(f) || !hidden.has(f)}
                      disabled={required.has(f)}
                      onChange={(e) => {
                        const next = new Set(hidden);
                        if (e.target.checked) next.delete(f);
                        else next.add(f);
                        change({ hidden: TITLE_BLOCK_FIELD_IDS.filter((x) => next.has(x)) });
                      }}
                      data-title-block-field-toggle={f}
                    />
                    {FIELD_LABEL[f]}
                    {required.has(f) && <span className="text-[11px] text-ink-faint">required</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </fieldset>
  );
}
