/** The API described in OpenAPI 3, served at /v1/openapi.json so tools can read it. */

const text = { type: "string" };
const when = { type: "string", format: "date-time" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const ok = (description: string, schema?: unknown) => ({ description, ...(schema ? { content: { "application/json": { schema } } } : {}) });
const list = (name: string) => ({ type: "object", properties: { data: { type: "array", items: ref(name) }, nextCursor: { type: "string", nullable: true, description: "Send as ?cursor= to get the next page. null on the last page." } } });
const param = (name: string, description: string, where: "query" | "path" = "query") => ({ name, in: where, required: where === "path", description, schema: text });
const failures = {
  "401": ok("The key is missing, wrong or revoked.", ref("Error")),
  "403": ok("The key can only read.", ref("Error")),
  "404": ok("Nothing with that id in this workspace.", ref("Error")),
  "422": ok("A value in the request is not allowed. The message says which.", ref("Error")),
  "429": ok("More than 300 requests in a minute with this key.", ref("Error")),
};
const paging = [param("limit", "Rows per page, 1 to 500. Default 100."), param("cursor", "The nextCursor of the previous page.")];

function resource(name: string, title: string, schema: string, input: string, filters: unknown[], notes: { create: string; remove: string }) {
  const id = param("id", `The id of the ${title}.`, "path");
  return {
    [`/${name}`]: {
      get: { summary: `List ${name}`, parameters: [...filters, ...paging], responses: { "200": ok("One page, ordered by id.", list(schema)), ...failures } },
      post: { summary: `Create a ${title}`, description: notes.create, requestBody: jsonBody(ref(input)), responses: { "201": ok("Created.", ref(schema)), ...failures } },
    },
    [`/${name}/{id}`]: {
      get: { summary: `Get one ${title}`, parameters: [id], responses: { "200": ok("Found.", ref(schema)), ...failures } },
      patch: { summary: `Change a ${title}`, description: "Send only the fields to change.", parameters: [id], requestBody: jsonBody(ref(input)), responses: { "200": ok("Changed.", ref(schema)), ...failures } },
      delete: { summary: `Delete a ${title}`, description: notes.remove, parameters: [id], responses: { "204": ok("Deleted."), ...failures } },
    },
  };
}

export function openApiDocument(server: string) {
  const objectInput = {
    name: { ...text, maxLength: 300 },
    typeId: { ...text, enum: ["domain", "actor", "system", "external-system", "application", "web-app", "mobile-app", "service", "database", "queue", "cache", "storage", "gateway", "server", "cluster", "network", "component", "ai-agent", "ai-model", "mcp-server", "process", "task", "event", "decision", "zone", "diagram"] },
    description: text,
    owner: text,
    lifecycle: { ...text, enum: ["planned", "active", "deprecated", "retired"] },
    tags: { type: "array", items: text },
    parentId: { ...text, nullable: true, description: "The object this one sits inside. It has to be of a higher level: domain, then system, then application or resource, then component." },
    technology: text,
    fields: { type: "object", additionalProperties: text },
  };
  const relationshipInput = {
    sourceId: text,
    targetId: text,
    kind: { ...text, enum: ["calls", "depends_on", "reads_writes", "hosted_on", "routes_to", "replicates_to"], default: "calls" },
    label: text,
    protocol: text,
    port: text,
    description: text,
  };
  const node = { type: "object", required: ["objectId"], properties: { objectId: text, x: { type: "number" }, y: { type: "number" }, pinned: { type: "boolean" } } };
  const diagramInput = {
    name: text,
    description: text,
    viewType: { ...text, enum: ["landscape", "context", "container", "deployment", "dataflow", "business", "custom"], default: "custom", description: "Set when the diagram is created; it cannot be changed afterwards." },
    direction: { ...text, enum: ["TB", "LR"] },
    nodes: { type: "array", items: node, description: "Boxes to place or move." },
    removeNodes: { type: "array", items: text, description: "Object ids to take off the diagram. Only on PATCH." },
  };
  const { removeNodes: _onlyOnInput, ...diagramShown } = diagramInput;
  const stepTypes = ["startEvent", "endEvent", "intermediateThrowEvent", "intermediateCatchEvent", "task", "userTask", "serviceTask", "manualTask", "scriptTask", "businessRuleTask", "sendTask", "receiveTask", "subProcess", "callActivity", "exclusiveGateway", "parallelGateway", "inclusiveGateway", "eventBasedGateway"];
  const kpi = { type: "object", required: ["name"], properties: { id: text, name: text, unit: text, target: text, actual: text, better: { ...text, enum: ["higher", "lower"] } } };
  const risk = { type: "object", required: ["name"], properties: { id: text, name: text, severity: { ...text, enum: ["low", "medium", "high"] }, control: text } };
  const processShown = {
    id: text,
    name: { ...text, maxLength: 200 },
    description: text,
    level: { type: "integer", minimum: 0, maximum: 4, description: "0 process area, 1 group, 2 process, 3 sub-process, 4 activity." },
    parentId: { ...text, nullable: true },
    category: { ...text, enum: ["management", "core", "support"] },
    owner: text,
    status: { ...text, enum: ["draft", "review", "published", "retired"] },
    version: { type: "integer", description: "The last published version; 0 before the first." },
    tags: { type: "array", items: text },
    frequency: text,
    modelled: { type: "boolean" },
    steps: { type: "integer", description: "Tasks, sub-processes and call activities in the model." },
    kpis: { type: "array", items: kpi },
    risks: { type: "array", items: risk },
    createdAt: when,
    updatedAt: when,
  };
  const element = {
    type: "object",
    description: "What the app keeps about a step or a flow, beside the BPMN file.",
    properties: {
      objectIds: { type: "array", items: text, description: "Objects of the model the step uses." },
      raci: { type: "object", additionalProperties: { ...text, enum: ["R", "A", "C", "I"] } },
      duration: { type: "object", properties: { min: { type: "number" }, mode: { type: "number" }, max: { type: "number" } }, description: "Minutes: least, usually, most." },
      cost: { type: "number" },
      probability: { type: "number", description: "On a flow out of a decision: percent of cases taking it." },
      resource: { ...text, description: "The role that does it; its lane when empty." },
      automation: { ...text, enum: ["manual", "partly", "automated", "candidate"] },
      decisionId: text,
      calledProcessId: text,
      notes: text,
    },
  };
  const processInput = {
    name: { ...text, maxLength: 200 },
    description: { ...text, maxLength: 4000 },
    level: processShown.level,
    parentId: { ...text, nullable: true, description: "A process at a lower level number." },
    category: processShown.category,
    owner: text,
    frequency: text,
    tags: processShown.tags,
    lanes: { type: "array", items: text, description: "With steps: the roles or teams, top to bottom." },
    steps: {
      type: "array",
      maxItems: 200,
      description: "The model as a list: laid out as BPMN by the server. A start and an end are added when left out.",
      items: { type: "object", required: ["id", "name", "type"], properties: { id: text, name: text, type: { ...text, enum: stepTypes }, lane: text, trigger: { ...text, enum: ["message", "timer", "error", "signal", "conditional", "escalation", "terminate"] }, minutes: { type: "number" } } },
    },
    flows: { type: "array", description: "With steps: what follows what. Without it, the steps follow one another.", items: { type: "object", required: ["from", "to"], properties: { from: text, to: text, name: text, probability: { type: "number" } } } },
    xml: { ...text, description: "Instead of steps: a BPMN 2.0 file with its diagram, at most 2.5 MB." },
    elements: { type: "object", additionalProperties: element, description: "By step or flow id. Replaces what was there." },
    kpis: { type: "array", items: kpi, description: "Replaces the list." },
    risks: { type: "array", items: risk, description: "Replaces the list." },
    status: { ...processShown.status, description: "review, published (as the next version, keeping the ten latest), retired, or back to draft." },
    note: { ...text, description: "With status: what changed, or what to look at." },
    reviewer: text,
  };
  const stamped = { id: text, origin: { ...text, description: "Where it came from: manual, ai-prompt, ai-image, import, api or demo." }, createdAt: when, updatedAt: when };
  return {
    openapi: "3.0.3",
    info: {
      title: "ArchONE Diagrams API",
      version: "1.0.0",
      description:
        "Read and change the model of one workspace: its objects, the relationships between them, its diagrams, and its business processes. A key belongs to one workspace and is created by an owner under Settings. Send it as `Authorization: Bearer <key>`. Changes made through the API appear at once for people who have the workspace open, and are sent to the workspace's webhooks.",
    },
    servers: [{ url: server }],
    security: [{ key: [] }],
    paths: {
      "/": { get: { summary: "The workspace this key belongs to", responses: { "200": ok("The workspace and what the key may do."), "401": failures["401"] } } },
      "/model": { get: { summary: "The whole model in one reply", description: "Every object, relationship and diagram, and every process without its BPMN file. For large models, page through the lists instead.", responses: { "200": ok("The model."), ...failures } } },
      ...resource("objects", "object", "Object", "ObjectInput", [param("type", "Only this type id."), param("lifecycle", "Only this lifecycle."), param("owner", "Only this owner, compared without case."), param("tag", "Only objects with this tag."), param("parent", "Only objects directly inside this object."), param("q", "Only names containing this text."), param("updatedSince", "Only objects changed at or after this date and time.")], {
        create: "`name` and `typeId` are required.",
        remove: "What was inside the object moves up one level. Its relationships and its boxes on diagrams are deleted with it.",
      }),
      ...resource("relationships", "relationship", "Relationship", "RelationshipInput", [param("source", "Only from this object."), param("target", "Only to this object."), param("object", "Only those that start or end at this object."), param("kind", "Only this kind.")], {
        create: "`sourceId` and `targetId` are required. The same source, target and kind is stored once: asking again returns the stored relationship with status 200.",
        remove: "The arrow disappears from every diagram.",
      }),
      ...resource("diagrams", "diagram", "Diagram", "DiagramInput", [], {
        create: "`name` is required. Boxes can be placed in the same request with `nodes`.",
        remove: "The objects on the diagram stay in the model. Live links to the diagram stop working.",
      }),
      ...resource(
        "processes",
        "process",
        "Process",
        "ProcessInput",
        [param("status", "Only draft, review, published or retired."), param("category", "Only management, core or support."), param("level", "Only this level, 0 to 4."), param("parent", "Only processes directly inside this process; none for the top."), param("owner", "Only this owner, compared without case."), param("q", "Only names containing this text."), param("uses", "Only processes whose steps use this object id."), param("updatedSince", "Only processes changed at or after this date and time.")],
        {
          create: "`name` is required. Send the model as `steps` and `flows`, which the server lays out, or as `xml`. Without either, a process (level 2 and below) starts with a start, one step and an end; an area or group has no model. Needs a key with write access that is not limited to domains.",
          remove: "What was inside the process moves up to its parent.",
        },
      ),
      "/proposals": {
        get: { summary: "List proposals filed through the API", parameters: [param("status", "Only pending, applied or dismissed.")], responses: { "200": ok("The newest 100, with the decision on every item."), ...failures } },
        post: {
          summary: "Propose changes for a person to review",
          description:
            "Nothing reaches the model until someone with edit access accepts it in the app. A key with propose access can change the model only this way. `title` is required. A new object carries a `key` of your own; an existing object is named by its `id`, and only the fields you send are changed. The ends of a relationship are keys of this proposal or ids of existing objects.",
          requestBody: jsonBody(ref("ProposalInput")),
          responses: { "201": ok("Filed, waiting for review."), ...failures },
        },
      },
      "/proposals/{id}": { get: { summary: "Get one proposal", parameters: [param("id", "The id of the proposal.", "path")], responses: { "200": ok("Found."), ...failures } } },
    },
    components: {
      securitySchemes: { key: { type: "http", scheme: "bearer", description: "An API key created under Settings, starting with ark_." } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: text, message: text } } } },
        Object: { type: "object", properties: { ...stamped, ...objectInput } },
        ObjectInput: { type: "object", properties: objectInput },
        Relationship: { type: "object", properties: { ...stamped, ...relationshipInput } },
        RelationshipInput: { type: "object", properties: relationshipInput },
        Diagram: { type: "object", properties: { id: text, createdAt: when, updatedAt: when, scopeId: { ...text, nullable: true }, ...diagramShown } },
        DiagramInput: { type: "object", properties: diagramInput },
        Process: {
          type: "object",
          description: "In a list, without xml, elements, decisions, scenarios, versions and objects.",
          properties: {
            ...processShown,
            xml: { ...text, description: "The BPMN 2.0 file with its diagram." },
            elements: { type: "object", additionalProperties: element },
            decisions: { type: "object", description: "DMN decision tables by id." },
            scenarios: { type: "array", items: { type: "object" }, description: "Saved simulation scenarios." },
            versions: { type: "array", items: { type: "object", properties: { version: { type: "integer" }, publishedAt: when, publishedBy: text, note: text } } },
            objects: { type: "object", description: "The objects the steps use, by id: name and typeId." },
            reviewer: text,
            reviewNote: text,
          },
        },
        ProcessInput: { type: "object", properties: processInput },
        ProposalInput: {
          type: "object",
          required: ["title"],
          properties: {
            title: { ...text, maxLength: 300 },
            notes: { ...text, maxLength: 4000 },
            diagramId: text,
            objects: { type: "array", maxItems: 200, items: { type: "object", properties: { key: text, id: text, name: text, typeId: text, description: text, owner: text, lifecycle: text, tags: { type: "array", items: text }, technology: text, parentKey: text } } },
            relationships: { type: "array", maxItems: 400, items: { type: "object", required: ["sourceKey", "targetKey"], properties: { sourceKey: text, targetKey: text, kind: text, label: text, protocol: text, port: text, description: text } } },
          },
        },
      },
    },
  };
}
