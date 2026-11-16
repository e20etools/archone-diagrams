import { MessageCircleQuestion, Waypoints } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { TypeIcon } from "@/components/icons";
import { Badge, Button, EmptyState, Input } from "@/components/ui";
import { AiError, fetchAiStatus, type AiStatus } from "@/lib/ai/client";
import { answerParts, exampleQuestions, type Answer } from "@/lib/ask/ask";
import { ask, clearExchanges, getAiChoice, rememberExchange, setAiChoice, useAskHistory } from "@/lib/ask/run";
import { useSession } from "@/lib/cloud/session";
import { useWorkspace } from "@/lib/store";
import type { Workspace } from "@/lib/types";

const SOURCE_LABEL: Record<Answer["source"], string> = { computed: "Read from the model", ai: "Written by the AI model", search: "No answer" };

function AnswerText({ ws, text }: { ws: Workspace; text: string }) {
  return (
    <div className="space-y-1" data-answer-text>
      {text.split("\n").map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        const item = line.startsWith("- ");
        return (
          <p key={i} className={item ? "pl-4 relative before:content-['•'] before:absolute before:left-0 before:text-ink-faint" : ""}>
            {answerParts(ws, item ? line.slice(2) : line).map((part, j) =>
              "objectId" in part ? (
                <Link key={j} to={`/model?object=${part.objectId}`} className="font-medium text-blueprint hover:underline" data-answer-object={part.objectId}>
                  {part.name}
                </Link>
              ) : (
                <Fragment key={j}>{part.text}</Fragment>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

function AnswerCard({ ws, question, answer }: { ws: Workspace; question: string; answer: Answer }) {
  const objects = answer.objectIds.map((id) => ws.objects[id]).filter(Boolean);
  const diagrams = answer.diagramIds.map((id) => ws.diagrams[id]).filter(Boolean);
  return (
    <li className="rounded-lg border border-line bg-surface" data-answer={answer.source}>
      <div className="px-5 py-3 border-b border-line-soft flex items-start justify-between gap-3">
        <p className="font-medium">{question}</p>
        <Badge tone={answer.source === "computed" ? "green" : answer.source === "ai" ? "blue" : "neutral"} title={answer.source === "ai" ? `Engine: ${answer.engine}` : undefined}>
          {SOURCE_LABEL[answer.source]}
        </Badge>
      </div>
      <div className="px-5 py-4">
        <AnswerText ws={ws} text={answer.text} />
        {answer.source === "ai" && (
          <p className="mt-3 text-[13px] text-ink-soft">
            An AI model ({answer.engine}) wrote this from the model's data. It can be wrong: follow the links to check before relying on it.
          </p>
        )}
      </div>
      {(objects.length > 0 || diagrams.length > 0) && (
        <div className="px-5 py-3 border-t border-line-soft space-y-2.5">
          {objects.length > 0 && (
            <div>
              <p className="text-[13px] text-ink-soft mb-1.5">Objects this answer rests on</p>
              <ul className="flex flex-wrap gap-1.5" data-answer-sources>
                {objects.slice(0, 24).map((o) => (
                  <li key={o.id} className="inline-flex items-center rounded-md border border-line bg-paper text-[13px]">
                    <Link to={`/model?object=${o.id}`} className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 hover:text-blueprint">
                      <TypeIcon typeId={o.typeId} componentId={o.componentId} size={13} />
                      {o.name}
                    </Link>
                    <Link to={`/analysis?object=${o.id}`} title={`Dependencies of ${o.name}`} aria-label={`Dependencies of ${o.name}`} className="px-1.5 py-1 border-l border-line text-ink-soft hover:text-blueprint">
                      <Waypoints size={13} />
                    </Link>
                  </li>
                ))}
                {objects.length > 24 && <li className="text-[13px] text-ink-soft self-center">and {objects.length - 24} more</li>}
              </ul>
            </div>
          )}
          {diagrams.length > 0 && (
            <p className="text-[13px]">
              <span className="text-ink-soft">Diagrams: </span>
              {diagrams.map((d, i) => (
                <Fragment key={d.id}>
                  {i > 0 && ", "}
                  <Link to={`/diagram/${d.id}`} className="text-blueprint hover:underline">
                    {d.name}
                  </Link>
                </Fragment>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function AskPage() {
  const ws = useWorkspace();
  const history = useAskHistory();
  // Answers belong to the workspace they were asked in.
  const workspaceKey = useSession((s) => s.workspaceId) ?? "local";
  const exchanges = history.workspaceId === workspaceKey ? history.exchanges : [];
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; settings: boolean } | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [useAi, setUseAi] = useState(getAiChoice);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetchAiStatus().then((status) => live && setAi(status));
    return () => {
      live = false;
    };
  }, []);

  const empty = Object.keys(ws.objects).length === 0;
  const examples = exampleQuestions(ws);

  const run = async (text: string) => {
    const asked = text.trim();
    if (asked.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await ask(ws, asked.slice(0, 1000), { aiConfigured: !!ai?.configured, useAi });
      rememberExchange(workspaceKey, asked, answer);
      setQuestion("");
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "The question could not be answered. Try again.", settings: e instanceof AiError && e.code === "access_code" });
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(question);
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-7">
      <h1 className="text-xl font-semibold">Ask the architecture</h1>
      <p className="text-ink-soft mt-0.5">Ask in plain words. The answer is read from the model, and every object in it links to where it lives.</p>

      {empty ? (
        <div className="mt-8 rounded-lg border border-dashed border-ink-faint bg-surface">
          <EmptyState title="Nothing to ask about yet" text="Questions are answered from the objects and relationships in the model. Add some, or import a file, then come back.">
            <Link to="/model" className="text-blueprint font-medium hover:underline">
              Open the model
            </Link>
          </EmptyState>
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="mt-5 flex gap-2">
            <Input
              ref={input}
              autoFocus
              value={question}
              maxLength={1000}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={examples[0] ?? "What depends on the orders database?"}
              aria-label="Your question"
            />
            <Button type="submit" variant="primary" icon={<MessageCircleQuestion size={15} />} disabled={busy || question.trim().length < 3}>
              {busy ? "Answering" : "Ask"}
            </Button>
          </form>

          {examples.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5" data-ask-examples>
              <span className="text-[13px] text-ink-soft mr-1">Try</span>
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={busy}
                  onClick={() => void run(example)}
                  className="rounded-full border border-line bg-surface px-2.5 py-1 text-[13px] hover:border-blueprint hover:text-blueprint disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 rounded-lg border border-line bg-paper px-4 py-3 text-[13px]" data-ask-engine>
            <p>
              Questions about dependencies, impact, owners, lifecycle, types and diagrams are worked out in your browser by reading the model. Nothing is sent anywhere and nothing is guessed. These questions are understood in
              English.
            </p>
            {ai?.configured ? (
              <label className="mt-2 flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-blueprint mt-0.5"
                  checked={useAi}
                  onChange={(e) => {
                    setUseAi(e.target.checked);
                    setAiChoice(e.target.checked);
                  }}
                />
                <span>
                  For other questions, ask the AI model ({ai.engine ?? "configured on this server"}). This sends the names, owners, descriptions and relationships of this model to that provider with each such question.
                </span>
              </label>
            ) : (
              ai && <p className="mt-2 text-ink-soft">No AI model is configured on this server, so other questions get the objects that match their words instead of an answer.</p>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
              {error.message}{" "}
              {error.settings && (
                <Link to="/settings" className="font-medium underline">
                  Open Settings
                </Link>
              )}
            </p>
          )}

          {exchanges.length > 0 && (
            <>
              <div className="mt-7 flex items-center justify-between">
                <h2 className="font-semibold">Answers</h2>
                <button type="button" className="text-[13px] text-ink-soft hover:text-ink" onClick={clearExchanges}>
                  Clear
                </button>
              </div>
              <ul className="mt-2.5 space-y-3" aria-live="polite">
                {exchanges.map((x) => (
                  <AnswerCard key={x.id} ws={ws} question={x.question} answer={x.answer} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
