import { namesOf } from "../handshake";
import { useWorkspace } from "../store";
import { cloudEnabled } from "./config";
import { useSession } from "./session";

/** The person at the keyboard: the name to sign things with, and the names an owner field may call them. */
export function useMe(): { name: string; names: string[]; speaksForEveryone: boolean } {
  const local = useWorkspace().userName.trim();
  const user = useSession((s) => s.user);
  const role = useSession((s) => s.role);
  return {
    name: local || user?.name || user?.email || "Unnamed",
    names: namesOf(user ?? {}, local),
    // Without a hosted backend there is one person; with one, a workspace owner may answer for any team.
    speaksForEveryone: !cloudEnabled || role === "owner",
  };
}
