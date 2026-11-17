/**
 * AWS Signature Version 4, with Web Crypto so it runs on any host (Vercel, Supabase Edge, Node).
 * Enough for the JSON APIs live discovery calls: a POST with a body and a few headers.
 */

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Signs a request and answers the headers to send with it. `now` is for tests. */
export async function signAws(
  request: { method: string; url: string; headers: Record<string, string>; body: string },
  service: string,
  region: string,
  credentials: AwsCredentials,
  now = new Date(),
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: url.host, "x-amz-date": amzDate };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = url.pathname.split("/").map((p) => encodeURIComponent(decodeURIComponent(p))).join("/") || "/";
  const canonical = [request.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, await sha256(request.body)].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, toSign));
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
