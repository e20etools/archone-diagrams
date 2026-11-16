import { z } from "zod";

/**
 * The workspace is model-based: objects and relationships are stored once and
 * diagrams only reference them (PRD FR-01, FR-02). Everything here is plain data
 * so it can move to a hosted database later without changing the UI.
 */

export const LIFECYCLES = ["planned", "active", "deprecated", "retired"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const RELATION_KINDS = [
  "calls",
  "depends_on",
  "reads_writes",
  "hosted_on",
  "routes_to",
  "replicates_to",
  "flows_to",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const VIEW_TYPES = ["landscape", "context", "container", "deployment", "dataflow", "custom"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const ORIGINS = ["manual", "ai-prompt", "ai-image", "import", "api", "demo"] as const;
export type Origin = (typeof ORIGINS)[number];

/** Where an item came from and who approved it (PRD AI-07). */
export const provenanceSchema = z.object({
  origin: z.enum(ORIGINS),
  /** The prompt text or the uploaded file name the item was drafted from. */
  source: z.string().optional(),
  /** The engine that drafted it, for example "anthropic:claude-sonnet-5-5" or "Built-in rules". */
  engine: z.string().optional(),
  proposalId: z.string().optional(),
  proposedAt: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** A pointer from the model to the real thing: the repository, the runbook, the dashboard. */
export const linkSchema = z.object({ label: z.string(), url: z.string() });
export type ModelLink = z.infer<typeof linkSchema>;

export const modelObjectSchema = z.object({
  id: z.string(),
  typeId: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.string(),
  lifecycle: z.enum(LIFECYCLES),
  tags: z.array(z.string()),
  parentId: z.string().nullable(),
  technology: z.string(),
  fields: z.record(z.string()),
  /** Missing when there are none, so an object without links reads back as it was sent. */
  links: z.array(linkSchema).optional(),
  provenance: provenanceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelObject = z.infer<typeof modelObjectSchema>;

/** Direction is always "source needs or uses target". */
export const relationshipSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  kind: z.enum(RELATION_KINDS),
  label: z.string(),
  protocol: z.string(),
  port: z.string(),
  description: z.string(),
  /** Set when the owner of the target has confirmed that the source depends on it. */
  acknowledgement: z.object({ by: z.string(), at: z.string() }).optional(),
  links: z.array(linkSchema).optional(),
  provenance: provenanceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Relationship = z.infer<typeof relationshipSchema>;

export const nodePlacementSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** True once a person has placed the node by hand; auto-layout then leaves it alone (PRD FR-09). */
  pinned: z.boolean(),
});
export type NodePlacement = z.infer<typeof nodePlacementSchema>;

/** How a diagram is drawn. The model behind it is the same in every notation. */
export const NOTATIONS = ["plain", "archimate", "bpmn"] as const;
export type Notation = (typeof NOTATIONS)[number];

export const COLOR_BY = ["type", "lifecycle", "owner"] as const;
export type ColorBy = (typeof COLOR_BY)[number];

/** One step of a flow: something passes from one box on the diagram to another, or happens inside one box. */
export const flowStepSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  text: z.string(),
});
export type FlowStep = z.infer<typeof flowStepSchema>;

/** A use case told step by step over one diagram, for example "A customer pays an invoice". */
export const flowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  steps: z.array(flowStepSchema),
});
export type Flow = z.infer<typeof flowSchema>;

/** A diagram is a view: a set of object references with positions, never a copy of the objects. */
export const diagramSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  viewType: z.enum(VIEW_TYPES),
  /** When set, the diagram shows the inside of this object (zoom level, PRD FR-04). */
  scopeId: z.string().nullable(),
  direction: z.enum(["TB", "LR"]),
  nodes: z.record(nodePlacementSchema),
  hiddenRelationshipIds: z.array(z.string()),
  /** Null shows every relationship kind; a list restricts the view to those kinds. */
  edgeKinds: z.array(z.enum(RELATION_KINDS)).nullable(),
  colorBy: z.enum(COLOR_BY),
  /** Missing means plain boxes and lines. */
  notation: z.enum(NOTATIONS).optional(),
  /** Missing when the diagram has none. */
  flows: z.array(flowSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Diagram = z.infer<typeof diagramSchema>;

export const DECISIONS = ["pending", "accepted", "rejected"] as const;
export type Decision = (typeof DECISIONS)[number];

export const proposedObjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  typeId: z.string(),
  description: z.string(),
  technology: z.string(),
  parentKey: z.string().nullable(),
  decision: z.enum(DECISIONS),
  /** An existing object with the same name; when set, accepting reuses it instead of creating a duplicate. */
  matchId: z.string().nullable(),
  // Only imports fill the rest. A spreadsheet row can carry these; a diagram file gives a position.
  owner: z.string().optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  tags: z.array(z.string()).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  /** The fields the file gave a value for. On an existing object, accepting writes exactly these. */
  provided: z.array(z.string()).optional(),
  /** For a draft from a meeting: the sentence this came from and who said it. */
  evidence: z.string().optional(),
  /** Free-form fields an import brings, for example the vendor and version an application portfolio records. */
  fields: z.record(z.string()).optional(),
});
export type ProposedObject = z.infer<typeof proposedObjectSchema>;

export const proposedRelationshipSchema = z.object({
  key: z.string(),
  sourceKey: z.string(),
  targetKey: z.string(),
  kind: z.enum(RELATION_KINDS),
  label: z.string(),
  decision: z.enum(DECISIONS),
  protocol: z.string().optional(),
  port: z.string().optional(),
  description: z.string().optional(),
  evidence: z.string().optional(),
});
export type ProposedRelationship = z.infer<typeof proposedRelationshipSchema>;

/** An AI draft or an imported file waiting for a person. Nothing in it reaches the model until it is applied (PRD AI-06). */
export const proposalSchema = z.object({
  id: z.string(),
  origin: z.enum(["ai-prompt", "ai-image", "import", "api"]),
  /** For an import: what kind of file it was. */
  importKind: z.enum(["spreadsheet", "visio", "drawio", "mermaid", "structurizr", "apm"]).optional(),
  /** A spreadsheet fills the model without drawing anything; a diagram file becomes a diagram laid out as it was drawn. */
  /** What a drafted proposal was drafted from, when it was not a description. */
  sourceKind: z.enum(["transcript"]).optional(),
  withoutDiagram: z.boolean().optional(),
  placeAsDrawn: z.boolean().optional(),
  source: z.string(),
  engine: z.string(),
  notes: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "applied", "dismissed"]),
  targetDiagramId: z.string().nullable(),
  objects: z.array(proposedObjectSchema),
  relationships: z.array(proposedRelationshipSchema),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  resultDiagramId: z.string().optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const ADR_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

/**
 * An architecture decision record: what was decided, why, and what follows from it.
 * Decisions are kept, never rewritten: a later one supersedes an earlier one.
 */
export const adrSchema = z.object({
  id: z.string(),
  /** Counts up within the workspace and never changes, so "ADR-7" always means the same decision. */
  number: z.number(),
  title: z.string(),
  status: z.enum(ADR_STATUSES),
  context: z.string(),
  decision: z.string(),
  consequences: z.string(),
  /** The objects the decision is about. */
  objectIds: z.array(z.string()),
  supersededBy: z.string().nullable(),
  /** "review" when the record was written by the closing of a review. */
  origin: z.enum(["manual", "review"]),
  reviewId: z.string().optional(),
  versionId: z.string().optional(),
  author: z.string(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Adr = z.infer<typeof adrSchema>;

/**
 * Which objects a rule of the workspace's own is about. Every part that is filled in has to
 * hold; a selector with nothing filled in means every object.
 */
export const selectorSchema = z.object({
  types: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  lifecycle: z.array(z.enum(LIFECYCLES)).default([]),
  /** Only objects that hold personal data. */
  personal: z.boolean().default(false),
  classification: z.array(z.string()).default([]),
  /** Part of the name, any case. */
  name: z.string().default(""),
  /** The id of an object: only what sits inside it, at any depth. */
  inside: z.string().nullable().default(null),
});
export type Selector = z.infer<typeof selectorSchema>;

export const OBJECT_REQUIREMENTS = ["owner", "description", "technology", "classification", "residency", "tag", "no-tag", "field", "lifecycle"] as const;
export type ObjectRequirement = (typeof OBJECT_REQUIREMENTS)[number];

/** What a rule checks. A journey is every way from one set of objects to another, following the arrows. */
export const ruleCheckSchema = z.discriminatedUnion("kind", [
  /** Every object the selector picks has something, or is something. `value` names the tag, the field (or "field=value") or the lifecycles allowed. */
  z.object({ kind: z.literal("object"), subject: selectorSchema, require: z.enum(OBJECT_REQUIREMENTS), value: z.string().default("") }),
  /** Between two sets of objects: never connected, connected only to each other, or connected over one of the protocols in `value`. */
  z.object({ kind: z.literal("connection"), from: selectorSchema, to: selectorSchema, mode: z.enum(["never", "only", "protocol"]), value: z.string().default("") }),
  /** On the way from one set to another: never through a third set, or always through it. */
  z.object({ kind: z.literal("journey"), from: selectorSchema, to: selectorSchema, through: selectorSchema, mode: z.enum(["never", "always"]) }),
]);
export type RuleCheck = z.infer<typeof ruleCheckSchema>;

/** A rule the workspace wrote for itself, run with the built-in checks. */
export const customRuleSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** The sentence the rule was written as, kept so the next person can see what was meant. */
  text: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  enabled: z.boolean(),
  check: ruleCheckSchema,
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomRule = z.infer<typeof customRuleSchema>;

export const workspaceSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  userName: z.string(),
  objects: z.record(modelObjectSchema),
  relationships: z.record(relationshipSchema),
  diagrams: z.record(diagramSchema),
  proposals: z.record(proposalSchema),
  /** Missing in workspaces saved before decisions existed. */
  adrs: z.record(adrSchema).default({}),
  /** The workspace's own rules. Missing in workspaces saved before they existed. */
  rules: z.record(customRuleSchema).default({}),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
