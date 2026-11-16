import { z } from "zod";
import { diagramObjects } from "./exporters";
import { visibleEdges } from "./views";
import { diagramSchema, modelObjectSchema, relationshipSchema } from "./types";
import type { Diagram, ModelObject, Relationship, Workspace } from "./types";

const sharePayloadSchema = z.object({
  v: z.literal(1),
  sharedAt: z.string(),
  sharedBy: z.string(),
  diagram: diagramSchema,
  scope: modelObjectSchema.nullable(),
  objects: z.array(modelObjectSchema).max(2000),
  relationships: z.array(relationshipSchema).max(10000),
});

/**
 * Read-only share links (PRD FR-31) that work without a server: the link itself
 * carries a compressed snapshot of one diagram after the # sign, so the data is
 * never sent to the host. With a password the snapshot is encrypted with AES-GCM.
 *
 * A snapshot link cannot be revoked or updated. Live, revocable links need the
 * hosted backend and are planned for phase 2.
 */

export interface SharePayload {
  v: 1;
  sharedAt: string;
  sharedBy: string;
  diagram: Diagram;
  scope: ModelObject | null;
  objects: ModelObject[];
  relationships: Relationship[];
}

export class ShareError extends Error {
  constructor(public code: "invalid" | "password-required" | "wrong-password") {
    super(code);
  }
}

const PBKDF2_ROUNDS = 150_000;

/** Viewers get what the diagram shows, not the prompts or files an item was drafted from. */
function publicObject(o: ModelObject): ModelObject {
  // Links often point at internal tools, so they stay with people who are signed in.
  const { links: _links, ...shown } = o;
  return { ...shown, provenance: { origin: o.provenance.origin } };
}

/**
 * The link carries exactly the arrows the diagram draws. A rolled-up arrow between two
 * parents is sent as one summary relationship, because the nested objects behind it are not shared.
 */
function sharedRelationships(ws: Workspace, diagram: Diagram): Relationship[] {
  return visibleEdges(ws, diagram).map((edge) => {
    const stored = edge.implied ? undefined : ws.relationships[edge.id];
    if (stored) {
      const { links: _links, ...shown } = stored;
      return { ...shown, provenance: { origin: stored.provenance.origin } };
    }
    return {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      kind: edge.kind,
      label: edge.label,
      protocol: "",
      port: "",
      description: "Summarises relationships between objects nested inside these two.",
      provenance: { origin: "manual" as const },
      createdAt: diagram.updatedAt,
      updatedAt: diagram.updatedAt,
    };
  });
}

export function buildSharePayload(ws: Workspace, diagram: Diagram): SharePayload {
  return {
    v: 1,
    sharedAt: new Date().toISOString(),
    sharedBy: ws.userName,
    diagram,
    scope: diagram.scopeId && ws.objects[diagram.scopeId] ? publicObject(ws.objects[diagram.scopeId]) : null,
    objects: diagramObjects(ws, diagram).map(publicObject),
    relationships: sharedRelationships(ws, diagram),
  };
}

/** Rebuilds a small read-only workspace from a payload so the normal canvas can draw it. */
export function payloadToWorkspace(payload: SharePayload): Workspace {
  const objects: Record<string, ModelObject> = {};
  for (const o of payload.objects) objects[o.id] = o;
  if (payload.scope) objects[payload.scope.id] = payload.scope;
  // Parents that were not shared are unknown to the viewer.
  for (const o of Object.values(objects)) if (o.parentId && !objects[o.parentId]) objects[o.id] = { ...o, parentId: null };
  const relationships: Record<string, Relationship> = {};
  for (const r of payload.relationships) if (objects[r.sourceId] && objects[r.targetId]) relationships[r.id] = r;
  return {
    version: 1,
    name: "Shared diagram",
    userName: "",
    objects,
    relationships,
    diagrams: { [payload.diagram.id]: { ...payload.diagram, hiddenRelationshipIds: [], edgeKinds: null } },
    proposals: {},
    adrs: {},
    rules: {},
    templates: {},
    updatedAt: payload.sharedAt,
  };
}

/* ---------- bytes ---------- */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream("gzip"));
const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream("gzip"));

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/* ---------- tokens ---------- */

/** Returns "1p.<data>" for an open link or "1e.<salt>.<iv>.<data>" for a password-protected one. */
export async function encodeShare(payload: SharePayload, password?: string): Promise<string> {
  const packed = await gzip(new TextEncoder().encode(JSON.stringify(payload)));
  if (!password) return `1p.${toBase64Url(packed)}`;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, packed as BufferSource));
  return `1e.${toBase64Url(salt)}.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

export const isProtectedShare = (token: string) => token.startsWith("1e.");

export async function decodeShare(token: string, password?: string): Promise<SharePayload> {
  const parts = token.split(".");
  let packed: Uint8Array;
  try {
    if (parts[0] === "1p" && parts.length === 2) {
      packed = fromBase64Url(parts[1]);
    } else if (parts[0] === "1e" && parts.length === 4) {
      if (!password) throw new ShareError("password-required");
      const key = await deriveKey(password, fromBase64Url(parts[1]));
      try {
        packed = new Uint8Array(
          await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(parts[2]) as BufferSource }, key, fromBase64Url(parts[3]) as BufferSource),
        );
      } catch {
        throw new ShareError("wrong-password");
      }
    } else {
      throw new ShareError("invalid");
    }
    // A link can come from anyone, so its content is checked against the schema before it is drawn.
    const parsed = sharePayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(await gunzip(packed))));
    if (!parsed.success) throw new ShareError("invalid");
    return parsed.data;
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError("invalid");
  }
}

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/share#${token}`;
}
