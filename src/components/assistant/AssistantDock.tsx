import { BotMessageSquare, Check, Copy, Mic, MicOff, PencilRuler, SendHorizontal, SquarePen, TriangleAlert, Undo2, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { IconButton, cx } from "@/components/ui";
import { fetchAiStatus, type AiStatus } from "@/lib/ai/client";
import { exampleQuestions } from "@/lib/ask/ask";
import { parseAnswer, type Block, type Inline } from "@/lib/assistant/answer";
import { answerConfirm, answerSuggestion, canUndo, getUseAi, newConversation, openConversation, pageOf, sendToAssistant, setAssistantOpen, setUseAi, undoStep, useAssistant, type ChangeStep, type ChatTurn, type DiagramChange } from "@/lib/assistant/chat";
import { viewCategory } from "@/lib/categories";
import { useCanEdit, useCategoryRank, useSession } from "@/lib/cloud/session";
import { DICTATION_LANGUAGES, useDictation } from "@/lib/dictation";
import { useStore, useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";

const EDIT_KEY = "archone.assistant.edit";

/** The answer with names in place of tags, to copy elsewhere. */
export const plainAnswer = (ws: Workspace, text: string) =>
  text.replace(/\[\[(d:)?([^\][\s]{1,80})\]\]/g, (_, d: string | undefined, id: string) => (d ? ws.diagrams[id]?.name : ws.objects[id]?.name) ?? (d ? "a diagram" : "an object"));

function InlineParts({ ws, parts }: { ws: Workspace; parts: Inline[] }) {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.kind) {
          case "text":
            return <Fragment key={i}>{part.text}</Fragment>;
          case "break":
            return <br key={i} />;
          case "code":
            return (
              <code key={i} className="rounded bg-paper px-1 py-px text-[12.5px]">
                {part.text}
              </code>
            );
          case "bold":
            return (
              <strong key={i} className="font-semibold">
                <InlineParts ws={ws} parts={part.children} />
              </strong>
            );
          case "object": {
            const o = ws.objects[part.id];
            return o ? (
              <Link key={i} to={`/model?object=${o.id}`} className="font-medium text-blueprint hover:underline" data-assistant-object={o.id}>
                {o.name}
              </Link>
            ) : (
              <span key={i} className="text-ink-soft">
                an object that is not in this workspace
              </span>
            );
          }
          case "diagram": {
            const d = ws.diagrams[part.id];
            return d ? (
              <Link key={i} to={`/diagram/${d.id}`} className="font-medium text-blueprint hover:underline" data-assistant-diagram={d.id}>
                {d.name}
              </Link>
            ) : (
              <span key={i} className="text-ink-soft">
                a diagram that is not in this workspace
              </span>
            );
          }
        }
      })}
    </>
  );
}

function BlockView({ ws, block }: { ws: Workspace; block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <p dir="auto" className="font-semibold">
          <InlineParts ws={ws} parts={block.inline} />
        </p>
      );
    case "paragraph":
      return (
        <p dir="auto">
          <InlineParts ws={ws} parts={block.inline} />
        </p>
      );
    case "code":
      return <pre className="overflow-x-auto rounded-md bg-paper px-2.5 py-2 text-[12.5px] leading-snug">{block.text}</pre>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag dir="auto" start={block.ordered ? block.start : undefined} className={cx("space-y-0.5 ps-5", block.ordered ? "list-decimal" : "list-disc")}>
          {block.items.map((item, i) => (
            <li key={i} className={item.level ? "ms-4 list-[circle]" : undefined}>
              <InlineParts ws={ws} parts={item.inline} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border border-line">
          <table dir="auto" className="w-full text-[12.5px]">
            <thead className="bg-paper text-ink-soft">
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} className="px-2 py-1 text-start font-medium">
                    <InlineParts ws={ws} parts={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-line-soft">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2 py-1 align-top">
                      <InlineParts ws={ws} parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function AnswerBody({ ws, text }: { ws: Workspace; text: string }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="space-y-2 break-words" data-assistant-answer>
      {blocks.map((block, i) => (
        <BlockView key={i} ws={ws} block={block} />
      ))}
    </div>
  );
}

const KIND_NOTE: Record<NonNullable<ChatTurn["kind"]>, string> = {
  ai: "AI answer from this workspace",
  computed: "Read from the model",
  search: "No answer: objects that match",
  error: "",
};

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-ink-faint hover:text-ink"
      aria-label="Copy the answer"
      title="Copy the answer"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function StepResult({ step, onUndo }: { step: ChangeStep; onUndo: () => void }) {
  const ws = useStore((s) => s.ws);
  return (
    <div className="space-y-1">
      {step.lines.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5" dir="auto" data-assistant-lines>
          {step.lines.map((line, i) => (
            <li key={i} className={step.undone ? "line-through text-ink-faint" : undefined}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {step.problems.map((p, i) => (
        <p key={i} className="text-ink-soft">
          Not done: {p}
        </p>
      ))}
      {!step.undone && step.findings.length > 0 && (
        <div className="rounded-md bg-signal-soft px-2 py-1.5 text-signal" data-assistant-findings>
          <p className="flex items-center gap-1 font-medium">
            <TriangleAlert size={13} aria-hidden /> The checks now find
          </p>
          <ul className="list-disc ps-5">
            {step.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {!step.undone && step.cleared > 0 && <p className="text-ok">{step.cleared === 1 ? "1 finding of the checks is cleared." : `${step.cleared} findings of the checks are cleared.`}</p>}
      {step.lines.length > 0 &&
        (step.undone ? (
          <p className="text-ink-faint">Undone.</p>
        ) : (
          <button
            type="button"
            disabled={!canUndo(step, ws)}
            onClick={onUndo}
            title={canUndo(step, ws) ? "Take this change back" : "Other changes came after this one: use Undo in the editor (Ctrl Z)"}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 hover:border-ink-faint disabled:opacity-50"
            data-assistant-undo
          >
            <Undo2 size={12} /> Undo
          </button>
        ))}
    </div>
  );
}

function ChangeCard({ turn, change }: { turn: ChatTurn; change: DiagramChange }) {
  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px]" data-assistant-change>
      {change.made && (
        <section data-assistant-made>
          <p className="mb-0.5 flex items-center gap-1 font-medium text-ink">
            <PencilRuler size={13} aria-hidden /> Changed on the diagram
          </p>
          <StepResult step={change.made} onUndo={() => undoStep(turn.id, "made")} />
        </section>
      )}
      {change.confirm.ops.length > 0 && (
        <section data-assistant-confirm={change.confirm.answer ?? "waiting"}>
          <p className="mb-0.5 font-medium text-ink">{change.confirm.answer ? (change.confirm.answer === "yes" ? "You said yes" : "You said no") : "Waiting for your yes"}</p>
          {change.confirm.step ? (
            <StepResult step={change.confirm.step} onUndo={() => undoStep(turn.id, "confirm")} />
          ) : (
            <ul className={cx("list-disc space-y-0.5 ps-5", change.confirm.answer === "no" && "line-through text-ink-faint")} dir="auto">
              {change.confirm.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {!change.confirm.answer && (
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" onClick={() => answerConfirm(turn.id, true)} className="rounded-md bg-blueprint px-2.5 py-0.5 font-medium text-on-accent hover:bg-blueprint-deep" data-assistant-yes>
                Yes, do it
              </button>
              <button type="button" onClick={() => answerConfirm(turn.id, false)} className="rounded-md border border-line px-2.5 py-0.5 hover:border-ink-faint" data-assistant-no>
                No
              </button>
            </div>
          )}
        </section>
      )}
      {change.suggest.length > 0 && (
        <section data-assistant-suggest>
          <p className="mb-0.5 font-medium text-ink">Suggestions</p>
          <ul className="space-y-1">
            {change.suggest.map((item, i) => (
              <li key={i} className="flex flex-wrap items-start gap-1.5" data-assistant-suggestion={i}>
                {item.step ? (
                  <div className="flex-1">
                    <StepResult step={item.step} onUndo={() => undoStep(turn.id, i)} />
                  </div>
                ) : (
                  <>
                    <span className={cx("min-w-0 flex-1", item.dismissed && "line-through text-ink-faint")} dir="auto">
                      {item.line}
                    </span>
                    {!item.dismissed && (
                      <>
                        <button type="button" onClick={() => answerSuggestion(turn.id, i, true)} className="rounded-md border border-blueprint px-2 py-0.5 font-medium text-blueprint hover:bg-blueprint-soft" data-assistant-take>
                          Do it
                        </button>
                        <button type="button" onClick={() => answerSuggestion(turn.id, i, false)} className="rounded-md px-1.5 py-0.5 text-ink-faint hover:text-ink" aria-label={`Put aside: ${item.line}`}>
                          <X size={12} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {change.dropped > 0 && <p className="text-ink-faint">{change.dropped === 1 ? "One change could not be read and was left out." : `${change.dropped} changes could not be read and were left out.`}</p>}
    </div>
  );
}

function Turn({ ws, turn }: { ws: Workspace; turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <li className="flex justify-end" data-assistant-turn="user">
        <p dir="auto" className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-ee-md bg-blueprint px-3 py-2 text-on-accent">
          {turn.text}
        </p>
      </li>
    );
  }
  if (turn.kind === "error") {
    return (
      <li data-assistant-turn="assistant" data-assistant-kind="error">
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-danger">
          {turn.text}
          {turn.engine === "access_code" || turn.engine === "not_configured" ? (
            <>
              {" "}
              <Link to="/settings" className="font-medium underline">
                Open Settings
              </Link>
            </>
          ) : null}
        </p>
      </li>
    );
  }
  return (
    <li data-assistant-turn="assistant" data-assistant-kind={turn.kind}>
      <div className="max-w-full rounded-2xl rounded-es-md border border-line-soft bg-paper/60 px-3 py-2">
        <AnswerBody ws={ws} text={turn.text} />
        {turn.change && <ChangeCard turn={turn} change={turn.change} />}
      </div>
      <div className="mt-1 flex items-center gap-2 px-1 text-[11.5px] text-ink-faint">
        <span title={turn.engine}>{turn.kind ? KIND_NOTE[turn.kind] : ""}</span>
        {turn.kind === "ai" && turn.engine && <span className="truncate">· {turn.engine}</span>}
        <span className="ms-auto">
          <CopyButton text={plainAnswer(ws, turn.text)} />
        </span>
      </div>
      {turn.partial && <p className="mt-1 px-1 text-[11.5px] text-signal">The workspace was too large to send whole, so this answer rests on part of it. Ask about one diagram by name for the full picture of it.</p>}
    </li>
  );
}

function suggestionsFor(ws: Workspace, onDiagram: boolean, ai: boolean, editing = false): string[] {
  if (!ai) return exampleQuestions(ws).slice(0, 4);
  if (editing) {
    return [
      "Summarise this diagram: what it shows, who made it and where its approval stands",
      "Add the protocols and ports to the connections that have none",
      "Check this diagram against the NCA ECC checks and fix what you can",
      "أضف خادم ويب جديد واربطه بقاعدة البيانات عبر HTTPS",
    ];
  }
  if (onDiagram) {
    return [
      "Summarise this diagram: what it shows, who made it and where its approval stands",
      "Which servers, networks and connections does this diagram use, with their protocols and ports?",
      "What did Cybersecurity and Enterprise Architecture note about this diagram?",
      "ما الذي يجب إصلاحه في هذا المخطط حسب ضوابط NCA ECC؟",
    ];
  }
  return [
    "Which diagrams wait for approval, and who has to act?",
    "Which connections are not encrypted?",
    "Who made each diagram, and when was it last changed?",
    "ما أهم الملاحظات الأمنية في مساحة العمل؟",
  ];
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "blue" }) {
  return <div className={cx("rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed", tone === "blue" ? "bg-blueprint-soft text-ink" : "bg-paper text-ink-soft")}>{children}</div>;
}

/** The assistant in the bottom-right corner of every page of the app. */
export function AssistantDock() {
  const ws = useWorkspace();
  const location = useLocation();
  const workspaceKey = useSession((s) => s.workspaceId) ?? "local";
  const { open, turns, busy } = useAssistant();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [useAi, setUse] = useState(getUseAi);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const page = useMemo(() => pageOf(ws, location.pathname, location.search), [ws, location.pathname, location.search]);
  const roleCanEdit = useCanEdit();
  const rankIn = useCategoryRank();
  const shown = page.diagramId ? ws.diagrams[page.diagramId] : undefined;
  const mayChange = !!shown && roleCanEdit && rankIn(viewCategory(shown.viewType)) >= 3;
  const [editOn, setEditOn] = useState(() => {
    try {
      return localStorage.getItem(EDIT_KEY) !== "no";
    } catch {
      return true;
    }
  });
  const [lang, setLang] = useState<string>(DICTATION_LANGUAGES[0].id);
  const dictation = useDictation((text) => setDraft((d) => `${d}${d && !/\s$/.test(d) ? " " : ""}${text}`));

  useEffect(() => openConversation(workspaceKey), [workspaceKey]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchAiStatus().then((status) => live && setAi(status));
    return () => {
      live = false;
    };
  }, [open, workspaceKey]);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [turns.length, busy, open]);

  const canAi = !!ai?.configured;
  const aiOn = canAi && useAi;
  const editing = aiOn && mayChange && editOn;
  const send = (text: string) => {
    if (!text.trim() || busy) return;
    if (dictation.listening) dictation.toggle(lang);
    setDraft("");
    void sendToAssistant(text, { ws, ai, useAi: aiOn, page, editDiagramId: editing ? page.diagramId : null });
  };
  const switchEditing = (on: boolean) => {
    setEditOn(on);
    try {
      localStorage.setItem(EDIT_KEY, on ? "yes" : "no");
    } catch {
      // The choice lasts for this visit.
    }
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };
  const close = () => {
    setAssistantOpen(false);
    setTimeout(() => launcher.current?.focus(), 0);
  };

  if (!open) {
    return (
      <button
        ref={launcher}
        type="button"
        onClick={() => setAssistantOpen(true)}
        className="fixed bottom-5 right-5 z-40 grid size-12 place-items-center rounded-full bg-blueprint text-on-accent shadow-[0_10px_28px_rgba(22,35,58,0.28)] hover:bg-blueprint-deep focus-visible:outline-offset-4"
        aria-label="Assistant: ask about this workspace"
        title="Assistant: ask about this workspace"
        data-assistant-launcher
      >
        <BotMessageSquare size={22} />
        {turns.length > 0 && <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-surface bg-ok" aria-hidden />}
      </button>
    );
  }

  const suggestions = suggestionsFor(ws, !!page.diagramId, aiOn, editing);
  return (
    <section
      role="dialog"
      aria-label="Assistant"
      className="fixed bottom-5 right-5 z-40 flex h-[min(660px,calc(100vh-5rem))] w-[min(430px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface text-sm shadow-[0_18px_48px_rgba(22,35,58,0.24)]"
      onKeyDown={(e) => e.key === "Escape" && close()}
      data-assistant-panel
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="grid size-8 place-items-center rounded-full bg-blueprint-soft text-blueprint">
          <BotMessageSquare size={17} />
        </span>
        <div className="min-w-0 leading-tight">
          <h2 className="font-semibold">Assistant</h2>
          <p className="truncate text-[11.5px] text-ink-faint" data-assistant-engine>
            {ai === null ? "Checking the AI model…" : editing ? `Changes this diagram with ${ai.engine ?? "the AI model"}` : aiOn ? `Answers with ${ai.engine ?? "the AI model"}` : canAi ? "AI answers are switched off" : "Reads the model; no AI model is set up"}
          </p>
        </div>
        <div className="ms-auto flex items-center">
          <IconButton label="New conversation" disabled={!turns.length || busy} onClick={newConversation}>
            <SquarePen size={16} />
          </IconButton>
          <IconButton label="Close the assistant" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {ai && canAi && !useAi && (
          <Notice tone="blue">
            <p>
              <span className="font-medium text-ink">Answer with AI?</span> Each question then sends what this workspace holds that you can see to {ai.engine ?? "the AI model"}: diagrams and who made them, objects with their details, connections, approvals with their notes, comments, check findings and people's names (or email address, for someone without a name). The app keeps none of it.
            </p>
            <button
              type="button"
              className="mt-2 rounded-md bg-blueprint px-2.5 py-1 font-medium text-on-accent hover:bg-blueprint-deep"
              onClick={() => {
                setUse(true);
                setUseAi(true);
              }}
              data-assistant-ai-on
            >
              Answer with AI
            </button>
          </Notice>
        )}
        {ai && !canAi && (
          <Notice>
            No AI model is set up, so only questions the built-in reader understands are answered, in English: dependencies, impact, owners, types and diagrams. An owner connects an AI provider in{" "}
            <Link to="/settings" className="font-medium text-blueprint hover:underline">
              Settings → Integrations
            </Link>
            .
          </Notice>
        )}
        {turns.length === 0 && (
          <div className="space-y-2.5 pt-1">
            <p className="text-ink-soft" dir="auto">
              {editing
                ? "Ask for changes to this diagram, by typing or speaking, in Arabic or English: add servers, networks and connections, set protocols, owners and details. Changes appear on the diagram at once and can be undone; removals wait for your yes. The assistant suggests improvements and warns when a change breaks the checks or the workspace's rules."
                : "Ask about the diagrams in this workspace and everything on them: who made them, servers, networks and connections, approvals and the notes of Enterprise Architecture and Cybersecurity, security checks and compliance. In Arabic or in English."}
            </p>
            {ai !== null && suggestions.length > 0 && (
              <ul className="flex flex-col items-start gap-1.5" data-assistant-suggestions>
                {suggestions.map((s) => (
                  <li key={s}>
                    <button type="button" dir="auto" disabled={busy} onClick={() => send(s)} className="rounded-2xl border border-line bg-surface px-3 py-1.5 text-start text-[13px] hover:border-blueprint hover:text-blueprint disabled:opacity-50">
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {turns.length > 0 && (
          <ul className="space-y-3" data-assistant-turns>
            {turns.map((turn) => (
              <Turn key={turn.id} ws={ws} turn={turn} />
            ))}
          </ul>
        )}
        {busy && (
          <p className="flex items-center gap-1.5 text-ink-faint" data-assistant-busy>
            <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
            <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse [animation-delay:150ms]" />
            <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse [animation-delay:300ms]" />
            <span className="ms-1">{aiOn ? "Reading the workspace and writing an answer" : "Reading the model"}</span>
          </p>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border border-line bg-paper px-2 py-1.5 focus-within:border-blueprint focus-within:ring-2 focus-within:ring-blueprint-soft">
          <textarea
            ref={input}
            dir="auto"
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={keys}
            placeholder={editing ? "Ask for a change, or ask about this diagram…" : page.diagramId ? "Ask about this diagram…" : "Ask about diagrams, servers, approvals…"}
            aria-label="Your message to the assistant"
            className="max-h-[120px] min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-sm placeholder:text-ink-faint focus:outline-none"
            data-assistant-input
          />
          {dictation.supported && (
            <button
              type="button"
              onClick={() => dictation.toggle(lang)}
              aria-label={dictation.listening ? "Stop speaking" : "Speak your message"}
              title={dictation.listening ? "Stop" : `Speak (${DICTATION_LANGUAGES.find((l) => l.id === lang)?.label})`}
              className={cx("grid size-8 shrink-0 place-items-center rounded-md", dictation.listening ? "bg-danger text-white" : "text-ink-soft hover:bg-line-soft hover:text-ink")}
              data-assistant-mic
            >
              {dictation.listening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send" title="Send (Enter)" className="grid size-8 shrink-0 place-items-center rounded-md bg-blueprint text-on-accent hover:bg-blueprint-deep disabled:opacity-40">
            <SendHorizontal size={16} />
          </button>
        </div>
        {(dictation.listening || dictation.problem) && (
          <p className="mt-1 px-1 text-[11.5px] text-ink-soft" dir="auto">
            {dictation.problem || dictation.hearing || "Listening…"}
          </p>
        )}
        <p className="mt-1.5 flex flex-wrap items-center gap-2 px-1 text-[11px] text-ink-faint">
          {dictation.supported && (
            <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={dictation.listening} aria-label="Language spoken" className="rounded border border-line bg-surface px-1 py-0.5 text-[11px]">
              {DICTATION_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
          {aiOn && mayChange && (
            <label className="inline-flex items-center gap-1 cursor-pointer text-ink-soft" data-assistant-edit-switch>
              <input type="checkbox" className="accent-blueprint" checked={editOn} onChange={(e) => switchEditing(e.target.checked)} data-assistant-edit-toggle />
              May change this diagram
            </label>
          )}
          <span>Answers can be wrong: check them.</span>
          {aiOn && (
            <button
              type="button"
              className="ms-auto hover:text-ink"
              onClick={() => {
                setUse(false);
                setUseAi(false);
              }}
              data-assistant-ai-off
            >
              Stop using AI
            </button>
          )}
        </p>
      </form>
    </section>
  );
}
