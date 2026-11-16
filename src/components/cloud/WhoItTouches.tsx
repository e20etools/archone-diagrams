import { useMemo } from "react";
import { Badge } from "@/components/ui";
import { personLabel } from "@/lib/cloud/collab";
import { useSession } from "@/lib/cloud/session";
import { reachOf } from "@/lib/cloud/stakeholders";
import type { Tables } from "@/lib/cloud/tables";

const some = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`);

/**
 * The owners of what a change touches and of what depends on it, set against the people
 * who review it. It is advice: the reviewers stay the ones the stages name.
 */
export function WhoItTouches({ before, after, reviewerIds }: { before: Tables | null; after: Tables; reviewerIds: string[] }) {
  const people = useSession((s) => s.people);
  const reach = useMemo(() => reachOf(before, after, people), [before, after, people]);
  if (!reach.stakeholders.length && !reach.unowned.length) return null;
  const outside = reach.stakeholders.filter((s) => !s.person || !reviewerIds.includes(s.person.userId));
  return (
    <div data-who-it-touches>
      {reach.stakeholders.length > 0 && (
      <p className="text-[13px] text-ink-soft">
        {outside.length === 0
          ? "Everyone who owns something this touches is among the reviewers."
          : `${outside.length === 1 ? "One owner" : `${outside.length} owners`} of what this touches ${outside.length === 1 ? "is" : "are"} not among the reviewers. A reviewer can hand a stage to a member, or mention them in a comment.`}
      </p>
      )}
      <ul className="mt-2 divide-y divide-line-soft">
        {reach.stakeholders.map((s) => {
          const reviews = !!s.person && reviewerIds.includes(s.person.userId);
          return (
            <li key={s.owner} className="py-2 flex items-start gap-3" data-stakeholder={s.owner}>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.owner}</span>
                {s.person && personLabel(s.person).toLowerCase() !== s.owner.toLowerCase() && <span className="text-ink-soft"> ({personLabel(s.person)})</span>}
                <span className="block text-[13px] text-ink-soft">
                  {s.changed.length > 0 && <>Owns what changes: {some(s.changed)}. </>}
                  {s.affected.length > 0 && <>Depends on it: {some(s.affected)}.</>}
                </span>
              </span>
              {reviews ? <Badge tone="green">Reviews this</Badge> : s.person ? <Badge tone="amber">Member, not a reviewer</Badge> : <Badge title="No member of this workspace has this name or email.">Not a member</Badge>}
            </li>
          );
        })}
      </ul>
      {reach.unowned.length > 0 && <p className="mt-2 text-[13px] text-ink-soft">Nobody is named as owner of: {some(reach.unowned)}.</p>}
    </div>
  );
}
