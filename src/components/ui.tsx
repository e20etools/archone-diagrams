import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/** Small, plain building blocks shared by every screen. */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON: Record<Variant, string> = {
  primary: "bg-blueprint text-white border-blueprint hover:bg-blueprint-deep",
  secondary: "bg-surface text-ink border-line hover:border-ink-faint",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-line-soft hover:text-ink",
  danger: "bg-surface text-danger border-line hover:border-danger hover:bg-danger-soft",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors",
        "disabled:opacity-45 disabled:pointer-events-none",
        size === "sm" ? "h-7 px-2 text-[13px]" : "h-8.5 px-3 text-sm",
        BUTTON[variant],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "inline-grid place-items-center size-8 rounded-md text-ink-soft hover:bg-line-soft hover:text-ink",
        "disabled:opacity-35 disabled:pointer-events-none",
        className,
      )}
    >
      {children}
    </button>
  );
}

export const inputClass =
  "w-full h-8.5 rounded-md border border-line bg-surface px-2.5 text-sm placeholder:text-ink-faint hover:border-ink-faint focus:border-blueprint focus:outline-none focus:ring-2 focus:ring-blueprint-soft";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="block text-[13px] font-medium text-ink-soft mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-faint mt-1">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, "pr-7", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...props} className={cx(inputClass, "h-auto py-2 leading-snug resize-y", props.className)} />;
}

/**
 * A text input that saves when the person leaves the field or presses Enter,
 * so one edit is one undo step instead of one per keystroke.
 */
export function CommitInput({
  value,
  onCommit,
  multiline,
  ...props
}: { value: string; onCommit: (value: string) => void; multiline?: boolean } & Omit<
  InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <Textarea
        {...(props as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <Input
      {...(props as InputHTMLAttributes<HTMLInputElement>)}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

type Tone = "neutral" | "blue" | "amber" | "green" | "red";
const TONES: Record<Tone, string> = {
  neutral: "bg-paper text-ink-soft border-line",
  blue: "bg-blueprint-soft text-blueprint-deep border-transparent",
  amber: "bg-signal-soft text-signal border-transparent",
  green: "bg-ok-soft text-ok border-transparent",
  red: "bg-danger-soft text-danger border-transparent",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center h-5 px-1.5 rounded border text-xs font-medium whitespace-nowrap", TONES[tone])}>
      {children}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Read before the dialog mounts: a field marked autoFocus takes the focus as it appears.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Runs once per dialog. Callers pass a new onClose on every render, and moving the focus
  // again each time would pull it out of the field being typed in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    const root = panel.current;
    if (root && !root.contains(document.activeElement)) {
      // The first field; without one, the first footer button, which is the one that changes nothing.
      const first =
        root.querySelector<HTMLElement>("[data-modal-body] :is(input, textarea, select):not([type=hidden], [type=file], [disabled])") ??
        root.querySelector<HTMLElement>("[data-modal-footer] button:not([disabled])") ??
        root.querySelector<HTMLElement>("button");
      first?.focus();
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [opener]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-h-[90vh] flex flex-col rounded-lg bg-surface border border-line shadow-[0_18px_50px_rgba(22,35,58,0.22)]"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between pl-5 pr-3 h-13 border-b border-line-soft shrink-0">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <div data-modal-body className="px-5 py-4 overflow-y-auto">
          {children}
        </div>
        {footer && (
          <div data-modal-footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-soft shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md text-center py-14 px-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-ink-soft mt-1.5">{text}</p>
      {children && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex gap-5 border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={cx(
            "relative -mb-px h-9 text-sm font-medium border-b-2 whitespace-nowrap",
            tab.id === value ? "border-blueprint text-ink" : "border-transparent text-ink-soft hover:text-ink",
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 text-ink-faint tabular-nums">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A short confirmation that disappears on its own. */
export function useNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(timer);
  }, [notice]);
  const view = notice ? (
    <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-md bg-nav text-nav-ink text-sm px-3.5 py-2 shadow-lg">
      {notice}
    </div>
  ) : null;
  return { notify: setNotice, view };
}

export const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
/** "1 object", "3 objects": a count with its noun in the right number. */
export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const formatDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
