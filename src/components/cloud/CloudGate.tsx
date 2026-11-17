import { LogOut, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Field, Input, Tabs, countOf } from "@/components/ui";
import { ROLE_INFO } from "@/lib/cloud/backend";
import { demoBackend } from "@/lib/cloud/config";
import {
  acceptInvite,
  clearNotice,
  createWorkspace,
  declineInvite,
  errorText,
  finishRecovery,
  getBackend,
  hasUnsavedChanges,
  localWorkspace,
  openWorkspace,
  signOut,
  startSession,
  useSession,
} from "@/lib/cloud/session";

function Mark() {
  return (
    <svg width="30" height="30" viewBox="0 0 26 26" aria-hidden className="text-ink">
      <rect x="1.5" y="1.5" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14.5" y="14.5" width="10" height="10" rx="2" fill="currentColor" />
      <path d="M11.5 6.5h5a3 3 0 0 1 3 3v5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full grid place-items-center px-4 py-10">
      <div className={wide ? "w-full max-w-xl" : "w-full max-w-sm"}>
        <div className="flex items-center gap-2.5 mb-5">
          <Mark />
          <span className="leading-tight">
            <span className="block font-semibold tracking-tight">ArchONE Diagrams</span>
            <span className="block text-[13px] text-ink-soft">Architecture diagrams from one shared model</span>
          </span>
        </div>
        {children}
        {demoBackend && (
          <p className="mt-4 text-xs text-signal">
            Demo backend: accounts and data stay in this browser only. It is for trying the screens, not for real work.
          </p>
        )}
      </div>
    </div>
  );
}

const Problem = ({ text }: { text: string }) =>
  text ? (
    <p role="alert" className="rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
      {text}
    </p>
  ) : null;

function AuthScreen() {
  const [mode, setMode] = useState<"in" | "up" | "reset">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sent, setSent] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    setSent("");
    try {
      const backend = await getBackend();
      if (mode === "in") await backend.signIn(email.trim(), password);
      else if (mode === "up") {
        const { needsConfirmation } = await backend.signUp(name.trim(), email.trim(), password);
        if (needsConfirmation) setSent(`We sent a confirmation link to ${email.trim()}. Open it, then sign in here.`);
      } else {
        await backend.sendPasswordReset(email.trim());
        setSent(`If ${email.trim()} has an account, a link to set a new password is on its way.`);
      }
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <div className="rounded-lg border border-line bg-surface px-6 py-5">
        {mode === "reset" ? (
          <h1 className="text-base font-semibold">Set a new password</h1>
        ) : (
          <Tabs
            tabs={[
              { id: "in", label: "Sign in" },
              { id: "up", label: "Create account" },
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next);
              setProblem("");
              setSent("");
            }}
          />
        )}
        <form onSubmit={submit} className="mt-4 space-y-3">
          {mode === "up" && (
            <Field label="Your name" hint="Shown to the people you work with, and recorded when you approve an AI draft.">
              <Input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
          )}
          <Field label="Email">
            <Input required type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {mode !== "reset" && (
            <Field label="Password" hint={mode === "up" ? "At least 8 characters." : undefined}>
              <Input
                required
                type="password"
                minLength={mode === "up" ? 8 : undefined}
                autoComplete={mode === "up" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          <Problem text={problem} />
          {sent && (
            <p role="status" className="rounded-md bg-ok-soft text-ok px-3 py-2 text-sm">
              {sent}
            </p>
          )}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button type="submit" variant="primary" disabled={busy}>
              {mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Email me a reset link"}
            </Button>
            {mode === "in" && (
              <button type="button" className="text-[13px] text-blueprint hover:underline" onClick={() => setMode("reset")}>
                Forgot your password?
              </button>
            )}
            {mode === "reset" && (
              <button type="button" className="text-[13px] text-blueprint hover:underline" onClick={() => setMode("in")}>
                Back to sign in
              </button>
            )}
          </div>
        </form>
      </div>
    </Frame>
  );
}

function RecoveryScreen() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      await (await getBackend()).setPassword(password);
      finishRecovery();
    } catch (error) {
      setProblem(errorText(error));
      setBusy(false);
    }
  };
  return (
    <Frame>
      <form onSubmit={submit} className="rounded-lg border border-line bg-surface px-6 py-5 space-y-3">
        <h1 className="text-base font-semibold">Choose a new password</h1>
        <Field label="New password" hint="At least 8 characters.">
          <Input required autoFocus type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Problem text={problem} />
        <Button type="submit" variant="primary" disabled={busy}>
          Save password
        </Button>
      </form>
    </Frame>
  );
}

function WorkspacePicker() {
  const { user, workspaces, invites } = useSession();
  const [name, setName] = useState("");
  const [fromLocal, setFromLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [local] = useState(localWorkspace);
  const navigate = useNavigate();

  const run = async (work: () => Promise<void>, entersWorkspace = true) => {
    setBusy(true);
    setProblem("");
    try {
      // The address may still point at a diagram of the workspace that was open before.
      if (entersWorkspace) navigate("/", { replace: true });
      await work();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const localSize = local ? `${countOf(Object.keys(local.objects).length, "object")} and ${countOf(Object.keys(local.diagrams).length, "diagram")}` : "";

  return (
    <Frame wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-ink-soft">
            Signed in as <span className="text-ink font-medium">{user?.name || user?.email}</span>
          </p>
          <Button variant="ghost" size="sm" icon={<LogOut size={14} />} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        <Problem text={problem} />

        {invites.length > 0 && (
          <section className="rounded-lg border border-signal/50 border-l-4 border-l-signal bg-surface px-5 py-4">
            <h2 className="text-base font-semibold">Invitations</h2>
            <ul className="mt-2 space-y-2">
              {invites.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{invite.workspaceName}</span>
                    <span className="block text-[13px] text-ink-soft">
                      {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} as {ROLE_INFO[invite.role].label.toLowerCase()}
                    </span>
                  </span>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => acceptInvite(invite.id))}>
                    Join
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => declineInvite(invite.id), false)}>
                    Decline
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-lg border border-line bg-surface px-5 py-4">
          <h1 className="text-base font-semibold">Your workspaces</h1>
          {workspaces.length === 0 ? (
            <p className="mt-1 text-ink-soft">None yet. A workspace holds one architecture model and the diagrams drawn from it. Create one below.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line-soft">
              {workspaces.map((w) => (
                <li key={w.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 font-medium truncate">
                    {w.name}
                    {w.scenarioOf && <span className="ml-2 font-normal text-[13px] text-ink-soft">scenario of {workspaces.find((x) => x.id === w.scenarioOf)?.name ?? "another workspace"}</span>}
                  </span>
                  <Badge>{ROLE_INFO[w.role].label}</Badge>
                  <Button size="sm" disabled={busy} onClick={() => void run(() => openWorkspace(w.id))}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form
          className="rounded-lg border border-line bg-surface px-5 py-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void run(() => createWorkspace(name, fromLocal && local ? local : undefined));
          }}
        >
          <h2 className="text-base font-semibold">New workspace</h2>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="For example: Payments platform" />
          </Field>
          {local && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-1 accent-blueprint" checked={fromLocal} onChange={(e) => setFromLocal(e.target.checked)} />
              <span>
                Start it with the model saved in this browser
                <span className="block text-[13px] text-ink-soft">{localSize}, from before you had an account. The browser copy is kept.</span>
              </span>
            </label>
          )}
          <Button type="submit" variant="primary" icon={<Plus size={15} />} disabled={busy || !name.trim()}>
            Create workspace
          </Button>
        </form>
      </div>
    </Frame>
  );
}

/** In hosted mode, stands between the visitor and the app until they are signed in and a workspace is open. */
export function CloudGate({ children }: { children: ReactNode }) {
  const phase = useSession((s) => s.phase);
  const notice = useSession((s) => s.notice);

  useEffect(() => startSession(), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  let screen: ReactNode;
  if (phase === "ready") screen = children;
  else if (phase === "signedOut") screen = <AuthScreen />;
  else if (phase === "recovery") screen = <RecoveryScreen />;
  else if (phase === "choosing") screen = <WorkspacePicker />;
  else
    screen = (
      <Frame>
        <p className="text-ink-soft" role="status">
          {phase === "loading" ? "Opening your workspace." : "Checking your sign-in."}
        </p>
      </Frame>
    );

  return (
    <>
      {screen}
      {notice && (
        <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] max-w-md rounded-md bg-nav text-nav-ink text-sm px-3.5 py-2 shadow-lg">
          {notice}
        </div>
      )}
    </>
  );
}
