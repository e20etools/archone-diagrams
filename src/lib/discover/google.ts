import { DiscoverError, type Remote } from "./remote";

/** A Google service account's JSON key: enough of it to ask for an access token. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string): ServiceAccount | null {
  try {
    // Some hosts keep the key on one line with its line breaks written as \n.
    const data = JSON.parse(raw) as Partial<ServiceAccount> & { type?: string };
    if (typeof data.client_email !== "string" || typeof data.private_key !== "string" || !data.private_key.includes("PRIVATE KEY")) return null;
    return { client_email: data.client_email, private_key: data.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

const base64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A signed JWT asserting the service account, for Google's token endpoint. */
export async function serviceAccountAssertion(account: ServiceAccount, scope: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = account.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${base64url(signature)}`;
}

export async function googleAccessToken(account: ServiceAccount, scope: string, remote: Remote): Promise<string> {
  let assertion: string;
  try {
    assertion = await serviceAccountAssertion(account, scope);
  } catch {
    throw new DiscoverError(400, "bad_settings", "The private key in DISCOVERY_GCP_SERVICE_ACCOUNT could not be read.");
  }
  const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const token = (await remote.json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })) as { access_token?: string };
  if (!token?.access_token) throw new DiscoverError(502, "credentials_refused", "Google gave no access token for the service account in DISCOVERY_GCP_SERVICE_ACCOUNT.");
  return token.access_token;
}
