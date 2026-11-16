/**
 * Hosted mode is on when the build knows a Supabase project. Without one the app runs as in
 * phase 1: one workspace kept in the browser, no sign-in.
 */
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

export const supabaseUrl = (env.VITE_SUPABASE_URL ?? "").trim().replace(/\/$/, "");
/** Supabase calls this the publishable key in newer projects and the anon key in older ones. Both are safe to ship. */
export const supabaseKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "").trim();
/** A stand-in backend that lives in the browser, for trying and testing the hosted screens without a server. */
export const demoBackend = env.VITE_CLOUD_BACKEND === "demo";

export const cloudEnabled = demoBackend || (supabaseUrl !== "" && supabaseKey !== "");

/** Where the stand-in backend keeps its data in this browser. */
export const DEMO_DB_KEY = "archone.demoServer";
