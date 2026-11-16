import { useWorkspace } from "@/lib/store";
import { Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Badge, Button, IconButton, Input, Modal, Select } from "@/components/ui";
import { ROLES, ROLE_INFO, type Member, type PendingInvite, type Role } from "@/lib/cloud/backend";
import { errorText, getBackend, showWorkspaceList, useSession } from "@/lib/cloud/session";
import { CATEGORIES, CATEGORY_INFO, CATEGORY_ROLES, CATEGORY_ROLE_LABEL, categoryRank, type CategoryRole, type CategoryRoles } from "@/lib/categories";

const INVITABLE = ROLES.filter((r) => r !== "owner");

/** Who can open this workspace and what each person may do. Owners manage it; everyone else can read it. */
export function MembersCard() {
  const workspaceId = useSession((s) => s.workspaceId);
  const me = useSession((s) => s.user);
  const myRole = useSession((s) => s.role);
  const ws = useWorkspace();
  const domainList = Object.values(ws.objects).filter((o) => o.typeId === "domain").sort((a, b) => a.name.localeCompare(b.name));
  const listed = useSession((s) => s.workspaces);
  const owner = myRole === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const people = await (await getBackend()).listPeople(workspaceId);
      setMembers(people.members);
      setInvites(people.invites);
    } catch (error) {
      setProblem(errorText(error));
    }
  }, [workspaceId]);
  // The session refreshes its lists when membership changes anywhere, which is the cue to reload here.
  useEffect(() => void refresh(), [refresh, listed]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem("");
    try {
      await work();
      await refresh();
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) return null;
  const invite = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address) return;
    if (members.some((m) => m.email === address)) return setProblem(`${address} is already a member.`);
    void run(async () => {
      await (await getBackend()).invite(workspaceId, address, role);
      setEmail("");
    });
  };

  return (
    <section className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 className="text-base font-semibold">Members</h2>
      <p className="text-ink-soft mt-0.5">
        {owner ? "Invite people by email. They see the invitation after they sign in with that address." : "Only an owner can invite people or change roles."}
      </p>

      <table className="mt-3 w-full text-left">
        <thead className="text-[13px] text-ink-soft border-b border-line">
          <tr>
            <th className="font-medium py-1.5">Person</th>
            <th className="font-medium py-1.5 w-80">Role</th>
            <th className="py-1.5 w-10">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const self = m.userId === me?.id;
            return (
              <tr key={m.userId} className="border-b border-line-soft last:border-b-0">
                <td className="py-2 align-top">
                  <span className="font-medium">{m.name || m.email}</span>
                  {self && <span className="ml-2 text-[13px] text-ink-faint">you</span>}
                  {m.name && <span className="block text-[13px] text-ink-soft">{m.email}</span>}
                </td>
                <td className="py-2">
                  {owner ? (
                    <Select
                      aria-label={`Role of ${m.name || m.email}`}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => {
                        // Read the choice now: by the time the request is sent, the list has drawn the old value again.
                        const next = e.target.value as Role;
                        void run(async () => (await getBackend()).setRole(workspaceId, m.userId, next));
                      }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_INFO[r].label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge>{ROLE_INFO[m.role].label}</Badge>
                  )}
                  {m.role === "editor" && (owner ? domainList.length > 0 || m.domains : m.domains) && (
                    <div className="mt-1.5 text-[13px]" data-member-limit={m.name || m.email}>
                      {owner ? (
                        <details>
                          <summary className="cursor-pointer text-ink-soft hover:text-ink">
                            {m.domains ? `Limited to ${m.domains.map((d) => ws.objects[d]?.name ?? "a deleted domain").join(", ")}` : "Changes the whole model"}
                          </summary>
                          <div className="mt-1.5 space-y-1">
                            {domainList.map((d) => (
                              <label key={d.id} className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="accent-blueprint"
                                  disabled={busy}
                                  checked={m.domains?.includes(d.id) ?? false}
                                  onChange={(e) => {
                                    const next = e.target.checked ? [...(m.domains ?? []), d.id] : (m.domains ?? []).filter((x) => x !== d.id);
                                    void run(async () => (await getBackend()).setMemberDomains(workspaceId, m.userId, next.length ? next : null));
                                  }}
                                />
                                Only inside {d.name}
                              </label>
                            ))}
                            <p className="text-xs text-ink-faint">With none ticked, this editor changes the whole model. With some ticked, only objects inside those domains and relationships that touch them.</p>
                          </div>
                        </details>
                      ) : (
                        <span className="text-ink-soft">Limited to {m.domains!.map((d) => ws.objects[d]?.name ?? "a deleted domain").join(", ")}</span>
                      )}
                    </div>
                  )}
                  {m.role !== "owner" && (owner || Object.keys(m.categoryRoles ?? {}).length > 0) && <CategoryRolesEditor member={m} owner={owner} busy={busy} onSave={(next) => void run(async () => (await getBackend()).setMemberCategoryRoles(workspaceId, m.userId, next))} />}
                </td>
                <td className="py-2 text-right align-top">
                  {(owner || self) && (
                    <IconButton label={self ? "Leave this workspace" : `Remove ${m.name || m.email}`} disabled={busy} onClick={() => setRemoving(m)}>
                      <Trash2 size={15} />
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
          {invites.map((i) => (
            <tr key={i.id} className="border-b border-line-soft last:border-b-0">
              <td className="py-2">
                <span className="font-medium">{i.email}</span>
                <span className="ml-2">
                  <Badge tone="amber">Invited, not joined yet</Badge>
                </span>
              </td>
              <td className="py-2 text-ink-soft">{ROLE_INFO[i.role].label}</td>
              <td className="py-2 text-right">
                <IconButton label={`Cancel the invitation for ${i.email}`} disabled={busy} onClick={() => void run(async () => (await getBackend()).cancelInvite(i.id))}>
                  <Trash2 size={15} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {owner && (
        <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-2">
          <label className="block flex-1 min-w-52">
            <span className="block text-[13px] font-medium mb-1">Invite by email</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </label>
          <label className="block w-40">
            <span className="block text-[13px] font-medium mb-1">As</span>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-describedby="role-help">
              {INVITABLE.map((r) => (
                <option key={r} value={r}>
                  {ROLE_INFO[r].label}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="primary" icon={<UserPlus size={15} />} disabled={busy || !email.trim()}>
            Invite
          </Button>
          <p id="role-help" className="basis-full text-xs text-ink-faint">
            {ROLE_INFO[role].label}: {ROLE_INFO[role].can.toLowerCase()}. No email is sent; tell the person to sign in with this address.
          </p>
        </form>
      )}
      {problem && (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft text-danger px-3 py-2 text-sm">
          {problem}
        </p>
      )}

      {removing && (
        <Modal
          title={removing.userId === me?.id ? "Leave this workspace?" : `Remove ${removing.name || removing.email}?`}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  void run(async () => {
                    await (await getBackend()).removeMember(workspaceId, target.userId);
                    if (target.userId === me?.id) showWorkspaceList();
                  });
                }}
              >
                {removing.userId === me?.id ? "Leave workspace" : "Remove member"}
              </Button>
            </>
          }
        >
          <p>
            {removing.userId === me?.id
              ? "You lose access to its model and diagrams. An owner can invite you again."
              : "They lose access at once. Their past changes stay in the model."}
          </p>
        </Modal>
      )}
    </section>
  );
}

const RANK_OF: Record<CategoryRole, number> = { editor: 3, commenter: 2, viewer: 1, none: 0 };

/**
 * A member's role in each category of diagram. A category can narrow the workspace role, not
 * widen it, so only the roles below it are offered. It also governs the objects of that category.
 */
function CategoryRolesEditor({ member, owner, busy, onSave }: { member: Member; owner: boolean; busy: boolean; onSave: (roles: CategoryRoles) => void }) {
  const roles = member.categoryRoles ?? {};
  const narrowedHere = CATEGORIES.filter((c) => roles[c]);
  const summary = narrowedHere.length
    ? narrowedHere.map((c) => `${CATEGORY_INFO[c].label}: ${CATEGORY_ROLE_LABEL[roles[c]!]}`).join(", ")
    : `${ROLE_INFO[member.role].label} in every category`;
  const ceiling = categoryRank(member.role, {}, "custom");
  if (!owner) return <p className="mt-1.5 text-[13px] text-ink-soft" data-member-categories={member.name || member.email}>{summary}</p>;
  return (
    <details className="mt-1.5 text-[13px]" data-member-categories={member.name || member.email}>
      <summary className="cursor-pointer text-ink-soft hover:text-ink">By category: {summary}</summary>
      <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        {CATEGORIES.map((c) => (
          <label key={c} className="contents">
            <span className="text-ink-soft">{CATEGORY_INFO[c].label}</span>
            <Select
              aria-label={`${CATEGORY_INFO[c].label} role of ${member.name || member.email}`}
              data-category-role={c}
              value={roles[c] ?? ""}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.value as CategoryRole | "";
                const next: CategoryRoles = { ...roles };
                if (value) next[c] = value;
                else delete next[c];
                onSave(next);
              }}
            >
              <option value="">Workspace role ({ROLE_INFO[member.role].label})</option>
              {CATEGORY_ROLES.filter((r) => RANK_OF[r] < ceiling).map((r) => (
                <option key={r} value={r}>
                  {CATEGORY_ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        A category covers its diagrams and the objects that belong to it: Data covers databases, queues, caches and storage; Infrastructure covers servers, clusters, gateways and network devices; Business covers processes and their
        steps; Applications covers systems, applications and services. People and domains belong to both Applications and Business. No access hides the category's diagrams; its objects stay visible because other
        diagrams draw them.
      </p>
    </details>
  );
}
