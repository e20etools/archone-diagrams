/** Requests from this server to a discovery source: time limits, refused redirects, and short error messages. */

export type DiscoverEnv = Record<string, string | undefined>;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BYTES = 20_000_000;

export class DiscoverError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A plain https address for a tool's server, or null. Plain http only for a stand-in on the same machine. */
export function toolBase(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return null;
  }
}

/** Requests to one source within one discovery: a time limit for each, and a deadline for all of them. */
export class Remote {
  private readonly deadline: number;
  constructor(
    private readonly label: string,
    private readonly settings: string,
    private readonly fetchImpl: typeof fetch,
    budgetMs = 50_000,
  ) {
    this.deadline = Date.now() + budgetMs;
  }

  /** Whether there is time for another page. */
  get hasTime() {
    return Date.now() < this.deadline - 3_000;
  }

  async json(url: string, init: RequestInit = {}, optional = false): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, this.deadline - Date.now())));
    let response: Response;
    try {
      // Redirects are refused: credentials must not follow an address somewhere else.
      response = await this.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal, headers: { accept: "application/json", ...(init.headers as Record<string, string>) } });
    } catch {
      clearTimeout(timer);
      if (optional) return undefined;
      throw new DiscoverError(502, "unreachable", `${this.label} could not be reached in time. Check the address in ${this.settings} and that this server may reach it.`);
    }
    try {
      const body = await response.text();
      if (body.length > MAX_BYTES) throw new DiscoverError(502, "too_large", `${this.label} answered with more than 20 MB.`);
      let data: unknown = undefined;
      try {
        data = body ? JSON.parse(body) : undefined;
      } catch {
        data = undefined;
      }
      if (response.ok) {
        if (data === undefined && !optional) throw new DiscoverError(502, "unreadable", `${this.label} answered with something other than JSON. Check the address in ${this.settings}.`);
        return data;
      }
      if (optional) return undefined;
      const said = providerMessage(data);
      const why =
        response.status === 401 || response.status === 403
          ? `${this.label} did not accept the credentials, or they may not read this. Check ${this.settings}.`
          : response.status === 404
            ? `${this.label} has nothing at that address. Check ${this.settings}.`
            : response.status === 429
              ? `${this.label} is limiting requests. Try again in a few minutes.`
              : `${this.label} answered with status ${response.status}.`;
      throw new DiscoverError(response.status === 429 ? 429 : 502, response.status === 401 || response.status === 403 ? "credentials_refused" : "source_failed", said ? `${why} It said: ${said}` : why);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The short reason a provider gives with an error, without anything else from its answer. */
function providerMessage(data: unknown): string {
  const r = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const error = (r.error && typeof r.error === "object" ? r.error : {}) as Record<string, unknown>;
  const message = [r.message, r.Message, error.message, r.error_description, typeof r.error === "string" ? r.error : undefined].find((m) => typeof m === "string" && m.trim());
  return typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

