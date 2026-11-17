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

export const VIEW_TYPES = ["landscape", "context", "container", "deployment", "dataflow", "business", "custom"] as const;
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
  /** The library component it was made from, for its icon and its basic information. Missing for a plain object. */
  componentId: z.string().optional(),
  /** For a box that stands for another diagram: that diagram. */
  diagramId: z.string().optional(),
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
  /** Which way traffic goes: out from the source to the target (the usual), in from the target, or both ways. */
  flow: z.enum(["out", "in", "both"]).optional(),
  /** The protocols and ports it uses, one or more. The protocol and port fields above repeat them as text. */
  protocols: z
    .array(z.object({ name: z.string().min(1).max(60), port: z.string().max(40).default(""), transport: z.enum(["TCP", "UDP", "TCP/UDP", "IP", "Other"]).optional() }))
    .max(12)
    .optional(),
  /** The network it runs over, such as MPLS, Internet or a site-to-site VPN. */
  network: z.string().max(80).optional(),
  /** Whether what it carries is encrypted on the way. */
  encrypted: z.enum(["yes", "no"]).optional(),
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
  /** Set while the diagram is archived; its history of archiving and restoring stays, with the reasons. */
  archive: z
    .object({
      archived: z.boolean(),
      history: z.array(z.object({ action: z.enum(["archived", "restored"]), at: z.string(), by: z.string(), reason: z.string() })),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Diagram = z.infer<typeof diagramSchema>;
export type DiagramArchive = NonNullable<Diagram["archive"]>;

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
  /** The library component it is, when the draft knows it exactly. */
  componentId: z.string().optional(),
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
  importKind: z.enum(["spreadsheet", "visio", "drawio", "mermaid", "structurizr", "apm", "iac", "discovery", "directory"]).optional(),
  /** A spreadsheet fills the model without drawing anything; a diagram file becomes a diagram laid out as it was drawn. */
  /** What a drafted proposal was drafted from, when it was not a description. */
  sourceKind: z.enum(["transcript", "voice"]).optional(),
  /** The diagram the draft becomes, as chosen when it was started: its name and kind. */
  diagramName: z.string().optional(),
  diagramViewType: z.enum(VIEW_TYPES).optional(),
  diagramScopeId: z.string().optional(),
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
  /** Issues or work items made from it in Jira or Azure DevOps, to follow it up. */
  issues: z.array(z.object({ system: z.string(), key: z.string(), url: z.string() })).optional(),
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

/** One question of the wizard, as the workspace has set it. */
export const wizardStepSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(60),
  question: z.string().max(200),
  /** The kinds of component offered; empty offers the whole library. */
  kinds: z.array(z.string()).max(30),
  /** The component an answer becomes when nothing more exact is chosen. */
  usual: z.string(),
  single: z.boolean().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().max(80).default(""),
  /** The answers sit inside the (first) answer of this step, such as the containers inside a system. */
  inside: z.string().optional(),
  /** The answers run one after another, in the order given. */
  chain: z.boolean().optional(),
  /** Lines from this step's answers to another step's. "spread" joins each answer to one answer of the other step in turn. */
  links: z
    .array(z.object({ to: z.string(), kind: z.enum(RELATION_KINDS), label: z.string().max(80).default(""), how: z.enum(["each", "spread"]).default("each") }))
    .max(10)
    .default([]),
});
export type WizardStepConfig = z.infer<typeof wizardStepSchema>;

/** The wizard's questions for one kind of diagram; the id is the kind. */
export const wizardConfigSchema = z.object({
  id: z.enum(VIEW_TYPES),
  steps: z.array(wizardStepSchema).min(1).max(20),
  author: z.string(),
  updatedAt: z.string(),
});
export type WizardConfig = z.infer<typeof wizardConfigSchema>;

export const PERSPECTIVE_IDS = ["applications", "data", "infrastructure", "business"] as const;

/**
 * A template the workspace made from one of its own diagrams. It keeps the boxes (each a
 * library component), the lines between them and where they stood, and nothing else: no
 * owners, descriptions, basic information or links, which belong to the real objects.
 */
/** A report a workspace makes for itself: what it lists, which columns, filters and grouping. */
export const FILTER_OPS = ["is", "is not", "contains", "does not contain", "is empty", "is not empty", "at least", "at most"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const customReportSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
  subject: z.enum(["components", "connections", "diagrams"]),
  columns: z.array(z.string().max(80)).min(1).max(20),
  filters: z.array(z.object({ field: z.string().max(80), op: z.enum(FILTER_OPS), value: z.string().max(200).default("") })).max(12).default([]),
  /** Counts the rows by this column, for the chart. */
  groupBy: z.string().max(80).nullable().default(null),
  sortBy: z.string().max(80).nullable().default(null),
  sortDesc: z.boolean().default(false),
  createdBy: z.string().max(120).default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomReport = z.infer<typeof customReportSchema>;

/** A workspace's branding, set by an owner: its name in the menu, logo, accent colour and default theme. */
export const brandingSchema = z.object({
  id: z.literal("workspace"),
  /** Shown in the menu and the browser tab. */
  appName: z.string().trim().max(40).default(""),
  /** A small image as a data URL. */
  logo: z.string().max(300_000).default(""),
  /** Overrides the theme's accent colour, as #rrggbb. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).or(z.literal("")).default(""),
  /** The theme for members who have not chosen one. */
  theme: z.string().max(40).default("blueprint"),
  font: z.string().max(40).default(""),
  updatedAt: z.string(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const savedTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  perspective: z.enum(PERSPECTIVE_IDS),
  about: z.string(),
  tags: z.string().default(""),
  direction: z.enum(["TB", "LR"]),
  notation: z.enum(["bpmn", "archimate"]).optional(),
  objects: z.array(z.object({ key: z.string(), name: z.string(), componentId: z.string(), typeId: z.string(), technology: z.string().default(""), x: z.number(), y: z.number() })),
  relationships: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(RELATION_KINDS), label: z.string().default(""), protocol: z.string().default("") })),
  /** The diagram it was made from, while that diagram exists. */
  sourceDiagramId: z.string(),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedTemplate = z.infer<typeof savedTemplateSchema>;

/**
 * A change the workspace made to the component library or the protocols: one of its own (new or
 * a copy), a built-in one changed (same id as the built-in), or a built-in one removed.
 */
export const libraryItemSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["component", "protocol"]),
  /** Hides a built-in component or protocol. */
  removed: z.boolean().optional(),
  component: z
    .object({
      name: z.string().min(1).max(120),
      sectionId: z.string().min(1).max(120),
      kind: z.string().min(1).max(60),
      icon: z.string().min(1).max(60),
      profile: z.string().min(1).max(60),
      aliases: z.string().max(400).default(""),
      provider: z.string().max(40).optional(),
    })
    .optional(),
  protocol: z
    .object({
      name: z.string().min(1).max(60),
      port: z.string().max(40).default(""),
      transport: z.enum(["TCP", "UDP", "TCP/UDP", "IP", "Other"]),
      group: z.string().min(1).max(60),
      secure: z.boolean(),
      use: z.string().max(300).default(""),
    })
    .optional(),
  /** The built-in or own item it was copied from. */
  copiedFrom: z.string().max(120).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

/**
 * Fair use of the AI in a workspace, set by its owners and applied by the server: whether AI is
 * on, who may use it, which features, limits per person and for the whole workspace (rolling
 * hour and 24 hours), and exceptions per person keyed by their user id.
 */
const limit = (max: number) => z.number().int().min(0).max(max);
export const aiPolicySchema = z.object({
  id: z.literal("workspace"),
  enabled: z.boolean(),
  who: z.enum(["members", "editors", "owners"]),
  features: z.object({ text: z.boolean(), image: z.boolean(), ask: z.boolean() }),
  perUser: z.object({ hour: limit(1000), day: limit(10000), tokensDay: limit(10_000_000) }),
  workspace: z.object({ day: limit(100000), tokensDay: limit(100_000_000) }),
  overrides: z.record(z.object({ day: limit(10000).optional(), hour: limit(1000).optional(), tokensDay: limit(10_000_000).optional(), blocked: z.boolean().optional() })).default({}),
  updatedAt: z.string(),
});
export type AiPolicy = z.infer<typeof aiPolicySchema>;

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
  /** Templates made from the workspace's own diagrams. Missing in workspaces saved before they existed. */
  templates: z.record(savedTemplateSchema).default({}),
  /** The workspace's own wizard questions, by kind of diagram. A kind without one uses the built-in questions. */
  wizards: z.record(wizardConfigSchema).default({}),
  /** The workspace's own reports. Missing in workspaces saved before they existed. */
  reports: z.record(customReportSchema).default({}),
  /** The workspace's branding, one record keyed "workspace". Missing in workspaces saved before it existed. */
  branding: z.record(brandingSchema).default({}),
  /** The workspace's own changes to the component library and the protocols. */
  library: z.record(libraryItemSchema).default({}),
  /** The workspace's limits on AI use, one record keyed "workspace". Missing means the built-in limits. */
  aiPolicy: z.record(aiPolicySchema).default({}),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
