import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { TrustContent } from "@/components/TrustContent";
import { formatDate } from "@/components/ui";
import { fetchTrustView, type TrustView } from "@/lib/cloud/trustView";

function Message({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface px-6 py-5">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1.5 text-ink-soft">{text}</p>
      </div>
    </div>
  );
}

const isLink = (text: string) => /^https?:\/\/\S+$/i.test(text);
const isEmail = (text: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

/** The public trust page: where personal data is kept and who receives it, drawn from the architecture model. Opens without signing in. */
export function TrustPage() {
  const { token = "" } = useParams();
  const [view, setView] = useState<TrustView | null>(null);
  useEffect(() => {
    let live = true;
    void fetchTrustView(token).then((next) => live && setView(next));
    return () => {
      live = false;
    };
  }, [token]);
  useEffect(() => {
    if (view?.status === "ok" && view.title) document.title = view.title;
  }, [view]);

  if (!view) return <Message title="Opening the page" text="One moment." />;
  if (view.status === "gone") return <Message title="This page is not available" text="It was switched off, or the address is mistyped." />;
  if (view.status === "unpublished") return <Message title="Nothing to show yet" text="This page appears once its content has been approved." />;
  if (view.status === "unreachable") return <Message title="The page could not be loaded" text="Check your connection and reload." />;

  const contact = view.contact.trim();
  return (
    <div className="h-full overflow-y-auto bg-surface" data-trust-page>
      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">{view.title}</h1>
        {view.intro && <p className="mt-4 text-[17px] leading-relaxed text-ink-soft whitespace-pre-wrap">{view.intro}</p>}
        <div className="mt-10">
          <TrustContent ws={view.ws} diagramId={view.diagramId} />
        </div>
        <footer className="mt-12 pt-5 border-t border-line text-[13px] text-ink-soft space-y-1">
          <p>
            Drawn from our architecture model{view.source === "published" ? ", in its reviewed and approved version," : ""} on {formatDate(view.at)}. The page changes when the model does.
          </p>
          {contact && (
            <p>
              Questions:{" "}
              {isEmail(contact) ? (
                <a className="font-medium text-blueprint hover:underline" href={`mailto:${contact}`}>
                  {contact}
                </a>
              ) : isLink(contact) ? (
                <a className="font-medium text-blueprint hover:underline" href={contact} rel="noreferrer">
                  {contact}
                </a>
              ) : (
                contact
              )}
            </p>
          )}
        </footer>
      </main>
    </div>
  );
}
