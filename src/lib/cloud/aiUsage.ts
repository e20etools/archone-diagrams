import { useCallback, useEffect, useState } from "react";
import { onAllowance } from "../ai/client";
import type { AiUsageReport } from "./backend";
import { cloudEnabled } from "./config";
import { getBackend, useSession } from "./session";

/**
 * The open workspace's AI use and limits, as the database counts them. Read again after every
 * AI request, so what is left stays current. Nothing in browser-only mode, where nobody is counted.
 */
export function useAiUsage(): { report: AiUsageReport | null; loading: boolean; error: string | null; refresh: () => void } {
  const workspaceId = useSession((s) => s.workspaceId);
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [loading, setLoading] = useState(cloudEnabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => onAllowance(() => refresh()), [refresh]);
  useEffect(() => {
    if (!cloudEnabled || !workspaceId) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    getBackend()
      .then((backend) => backend.aiUsageReport(workspaceId))
      .then((next) => {
        if (!live) return;
        setReport(next);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [workspaceId, tick]);
  return { report, loading, error, refresh };
}

/** "12 of 40 left in the last 24 hours" for the person's own allowance. */
export function allowanceText(report: AiUsageReport | null): string | null {
  if (!report) return null;
  const { me } = report;
  if (me.limits.paused) return "An owner has paused AI for you in this workspace.";
  if (me.limits.unlimited) return "No AI limits for you: owners of this workspace have none.";
  const day = Math.max(0, me.limits.day - me.day);
  const hour = Math.max(0, me.limits.hour - me.hour);
  return `${Math.min(day, hour)} AI ${Math.min(day, hour) === 1 ? "request" : "requests"} left now: ${hour} of ${me.limits.hour} this hour, ${day} of ${me.limits.day} in 24 hours.`;
}
