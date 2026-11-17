/**
 * The outside services a workspace can connect to from Settings → Integrations. What is not
 * secret (an address, regions, a user name) is kept with the workspace; what is secret (a key,
 * a password, a token) is kept encrypted in the database's vault and is never sent back to a
 * browser. The integrations Edge Function reads both, with the service role, to connect.
 *
 * Each field also names the setting the server-side connectors read, so one connector serves
 * both a workspace's integration and the host's DISCOVERY_ settings.
 */

export const INTEGRATION_IDS = [
  "ai",
  "aws",
  "azure",
  "gcp",
  "servicenow",
  "bmc",
  "device42",
  "apm",
  "github",
  "entra",
  "okta",
  "teams",
  "slack",
  "email",
  "jira",
  "azure-devops",
  "confluence",
] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export type IntegrationGroup = "AI" | "Cloud providers" | "Discovery and CMDB" | "Application portfolio" | "Code" | "Identity and directory" | "Notifications" | "Work tracking" | "Documentation";
export const INTEGRATION_GROUPS: IntegrationGroup[] = ["AI", "Cloud providers", "Discovery and CMDB", "Application portfolio", "Code", "Identity and directory", "Notifications", "Work tracking", "Documentation"];
/** What the app does with it. */
export type IntegrationUse = "ai" | "discover" | "apm" | "repository" | "directory" | "notify" | "issues" | "publish";

/**
 * AI providers with a free plan that speak the OpenAI chat format. The suggested models are a
 * starting point: "Load models" in Settings lists what the key can use, and free models change.
 */
export interface AiProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  visionModel?: string;
  free: string;
  keyUrl: string;
}
export const AI_PROVIDERS: AiProviderDef[] = [
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", visionModel: "qwen/qwen3.8-27b", free: "Free plan with no card: about 30 requests a minute and 1,000 a day on Llama 3.3 70B. Very fast.", keyUrl: "https://console.groq.com/keys" },
  { id: "gemini", label: "Google Gemini (AI Studio)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", visionModel: "gemini-flash-latest", free: "Free tier on selected Gemini models with daily limits; very long context and pictures.", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", free: "One key for many models; those ending in :free cost nothing, about 20 a minute and 50 a day.", keyUrl: "https://openrouter.ai/keys" },
  { id: "cerebras", label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", free: "Free plan of about a million tokens a day; shorter context on the free plan.", keyUrl: "https://cloud.cerebras.ai" },
  { id: "mistral", label: "Mistral (free mode)", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest", visionModel: "mistral-small-latest", free: "Free mode with limits set per account; hosted in the EU.", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "github", label: "GitHub Models", baseUrl: "https://models.github.ai/inference", model: "openai/gpt-4.1-mini", visionModel: "openai/gpt-4.1-mini", free: "Free for GitHub accounts with daily limits per model. The key is a GitHub token with the models permission.", keyUrl: "https://github.com/settings/personal-access-tokens" },
  { id: "sambanova", label: "SambaNova Cloud", baseUrl: "https://api.sambanova.ai/v1", model: "Meta-Llama-3.3-70B-Instruct", free: "Free plan with no card, rate limited per model.", keyUrl: "https://cloud.sambanova.ai/apis" },
  { id: "cloudflare", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", free: "10,000 neurons a day free. Needs the account ID and an API token with Workers AI access.", keyUrl: "https://dash.cloudflare.com/profile/api-tokens" },
];
export const aiProviderOf = (id: unknown) => AI_PROVIDERS.find((p) => p.id === id);
/** The chat address of an AI integration's provider, or null. */
export function aiBaseUrl(settings: Record<string, unknown>): string | null {
  const provider = aiProviderOf(settings.provider);
  if (!provider) return null;
  if (!provider.baseUrl.includes("{account}")) return provider.baseUrl;
  const account = typeof settings.accountId === "string" ? settings.accountId.trim() : "";
  return /^[a-f0-9]{32}$/i.test(account) ? provider.baseUrl.replace("{account}", account) : null;
}

export const EMAIL_SERVICES = [
  { value: "resend", label: "Resend" },
  { value: "sendgrid", label: "SendGrid" },
  { value: "mailgun", label: "Mailgun" },
  { value: "postmark", label: "Postmark" },
];

export interface IntegrationField {
  key: string;
  label: string;
  /** Kept encrypted; a browser can learn only whether it is set. */
  secret?: boolean;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
  /** A choice from a list instead of free text. */
  options?: { value: string; label: string }[];
  /** Shown only when another field has one of these values. */
  when?: { key: string; values: string[] };
  /** The server setting it stands for. */
  env: string;
}

export interface IntegrationDef {
  id: IntegrationId;
  label: string;
  group: IntegrationGroup;
  /** What connecting it does, in a sentence. */
  what: string;
  /** The read-only access to give the credentials. */
  access: string;
  /** What it is used for in the app. */
  use: IntegrationUse;
  fields: IntegrationField[];
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "ai",
    label: "AI provider",
    group: "AI",
    what: "Drafts diagrams from descriptions, pictures and meetings, and answers questions about the model, with this workspace's own key. The fair-use limits in Settings → AI still apply.",
    access: "An API key from the provider. Every provider listed has a free plan.",
    use: "ai",
    fields: [
      { key: "provider", label: "Provider", required: true, env: "AI_PROVIDER", options: AI_PROVIDERS.map((p) => ({ value: p.id, label: p.label })) },
      { key: "apiKey", label: "API key", secret: true, required: true, env: "AI_API_KEY" },
      { key: "accountId", label: "Cloudflare account ID", env: "AI_ACCOUNT_ID", when: { key: "provider", values: ["cloudflare"] }, placeholder: "32 letters and digits" },
      { key: "model", label: "Model", env: "AI_MODEL", hint: "The provider's suggested free model when empty. Load models lists what the key can use." },
      { key: "visionModel", label: "Model for pictures", env: "AI_VISION_MODEL", hint: "Optional: a model that reads images, for drafting from a picture." },
    ],
  },
  {
    id: "aws",
    label: "Amazon Web Services",
    group: "Cloud providers",
    what: "Reads the resources AWS Config records, with the network each sits in and what it is attached to.",
    access: "An IAM user or role allowed config:SelectResourceConfig (or config:SelectAggregateResourceConfig for an aggregator), with AWS Config recording.",
    use: "discover",
    fields: [
      { key: "accessKeyId", label: "Access key ID", secret: true, required: true, env: "DISCOVERY_AWS_ACCESS_KEY_ID", placeholder: "AKIA..." },
      { key: "secretAccessKey", label: "Secret access key", secret: true, required: true, env: "DISCOVERY_AWS_SECRET_ACCESS_KEY" },
      { key: "sessionToken", label: "Session token", secret: true, env: "DISCOVERY_AWS_SESSION_TOKEN", hint: "Only for temporary credentials." },
      { key: "regions", label: "Regions", env: "DISCOVERY_AWS_REGIONS", placeholder: "eu-west-1, me-central-1", hint: "Separated by commas. us-east-1 when empty." },
      { key: "aggregator", label: "AWS Config aggregator", env: "DISCOVERY_AWS_AGGREGATOR", hint: "Optional: reads every account and region the aggregator collects, in the first region above." },
    ],
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    group: "Cloud providers",
    what: "Reads the resources in your subscriptions through Azure Resource Graph, with virtual networks and subnets as zones.",
    access: "An app registration (service principal) with the Reader role on the subscriptions.",
    use: "discover",
    fields: [
      { key: "tenantId", label: "Tenant ID", required: true, env: "DISCOVERY_AZURE_TENANT_ID", placeholder: "00000000-0000-0000-0000-000000000000 or contoso.onmicrosoft.com" },
      { key: "clientId", label: "Client ID", required: true, env: "DISCOVERY_AZURE_CLIENT_ID" },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, env: "DISCOVERY_AZURE_CLIENT_SECRET" },
      { key: "subscriptions", label: "Subscriptions", env: "DISCOVERY_AZURE_SUBSCRIPTIONS", hint: "Optional, separated by commas. Every subscription the app may read when empty." },
    ],
  },
  {
    id: "gcp",
    label: "Google Cloud",
    group: "Cloud providers",
    what: "Reads the resources in a project, folder or organization through Cloud Asset Inventory.",
    access: "A service account with the Cloud Asset Viewer role, and the Cloud Asset API turned on.",
    use: "discover",
    fields: [
      { key: "serviceAccount", label: "Service account key (JSON)", secret: true, required: true, multiline: true, env: "DISCOVERY_GCP_SERVICE_ACCOUNT", hint: "Paste the whole JSON key file." },
      { key: "scope", label: "Scope", required: true, env: "DISCOVERY_GCP_SCOPE", placeholder: "projects/my-project", hint: "projects/ID, folders/NUMBER or organizations/NUMBER." },
    ],
  },
  {
    id: "servicenow",
    label: "ServiceNow CMDB",
    group: "Discovery and CMDB",
    what: "Reads configuration items and their relationships from the CMDB through the Table API.",
    access: "A user (or OAuth token) that may read cmdb_ci and cmdb_rel_ci.",
    use: "discover",
    fields: [
      { key: "url", label: "Instance address", required: true, env: "DISCOVERY_SERVICENOW_URL", placeholder: "https://yourcompany.service-now.com" },
      { key: "user", label: "User name", env: "DISCOVERY_SERVICENOW_USER" },
      { key: "password", label: "Password", secret: true, env: "DISCOVERY_SERVICENOW_PASSWORD" },
      { key: "token", label: "OAuth token", secret: true, env: "DISCOVERY_SERVICENOW_TOKEN", hint: "Instead of a user name and password." },
      { key: "query", label: "Which configuration items", env: "DISCOVERY_SERVICENOW_QUERY", placeholder: "operational_status=1^sys_class_nameINcmdb_ci_server,cmdb_ci_appl", hint: "Optional: an encoded query on cmdb_ci." },
    ],
  },
  {
    id: "bmc",
    label: "BMC Helix Discovery",
    group: "Discovery and CMDB",
    what: "Runs searches for hosts, the software running on them, what it depends on and the applications that group it.",
    access: "A user allowed to run searches, and its API token.",
    use: "discover",
    fields: [
      { key: "url", label: "Appliance or instance address", required: true, env: "DISCOVERY_BMC_URL", placeholder: "https://discovery.example.com" },
      { key: "token", label: "API token", secret: true, required: true, env: "DISCOVERY_BMC_TOKEN" },
      { key: "apiVersion", label: "API version", env: "DISCOVERY_BMC_API_VERSION", placeholder: "1.0" },
      { key: "queries", label: "Searches", multiline: true, env: "DISCOVERY_BMC_QUERIES", hint: "Optional: one search per line, instead of the built-in ones." },
    ],
  },
  {
    id: "device42",
    label: "Device42",
    group: "Discovery and CMDB",
    what: "Reads devices, where virtual machines run, application components and the service communications between devices.",
    access: "A read-only user that may run DOQL queries.",
    use: "discover",
    fields: [
      { key: "url", label: "Appliance address", required: true, env: "DISCOVERY_DEVICE42_URL", placeholder: "https://d42.example.com" },
      { key: "user", label: "User name", required: true, env: "DISCOVERY_DEVICE42_USER" },
      { key: "password", label: "Password", secret: true, required: true, env: "DISCOVERY_DEVICE42_PASSWORD" },
      { key: "doql", label: "Service communications query", multiline: true, env: "DISCOVERY_DEVICE42_DOQL", hint: "Optional: a DOQL query with client, listener, port and protocol columns." },
    ],
  },
  {
    id: "apm",
    label: "APM & Landscape",
    group: "Application portfolio",
    what: "Reads the applications, classifications, lifecycle and integrations APM publishes, as a draft to review.",
    access: "A Power BI or Excel feed token created in APM under Connections.",
    use: "apm",
    fields: [
      { key: "url", label: "APM address", required: true, env: "APM_FEED_URL", placeholder: "https://apm.e20e.tools" },
      { key: "token", label: "Feed token", secret: true, required: true, env: "APM_FEED_TOKEN", placeholder: "apmf_..." },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    group: "Code",
    what: "Imports infrastructure as code (Terraform, CloudFormation, Bicep, Kubernetes, Compose) straight from a repository, as a draft.",
    access: "A fine-grained personal access token with read access to the repository contents.",
    use: "repository",
    fields: [
      { key: "token", label: "Access token", secret: true, required: true, env: "GITHUB_TOKEN", placeholder: "github_pat_..." },
      { key: "repository", label: "Default repository", env: "GITHUB_REPOSITORY", placeholder: "owner/name" },
      { key: "url", label: "GitHub Enterprise address", env: "GITHUB_API_URL", placeholder: "https://github.example.com/api/v3", hint: "Only for GitHub Enterprise Server." },
    ],
  },
  {
    id: "entra",
    label: "Microsoft Entra ID (Azure AD)",
    group: "Identity and directory",
    what: "Imports people and groups from the directory, as owners and teams in the model. Active Directory synced to Entra ID is included.",
    access: "An app registration with the Microsoft Graph application permissions User.Read.All and GroupMember.Read.All, with admin consent.",
    use: "directory",
    fields: [
      { key: "tenantId", label: "Tenant ID", required: true, env: "ENTRA_TENANT_ID" },
      { key: "clientId", label: "Client ID", required: true, env: "ENTRA_CLIENT_ID" },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, env: "ENTRA_CLIENT_SECRET" },
      { key: "groupFilter", label: "Groups to read", env: "ENTRA_GROUP_FILTER", placeholder: "IT-", hint: "Optional: only groups whose name starts with this." },
    ],
  },
  {
    id: "okta",
    label: "Okta",
    group: "Identity and directory",
    what: "Imports people and groups from Okta, as owners and teams in the model.",
    access: "A read-only administrator's API token.",
    use: "directory",
    fields: [
      { key: "url", label: "Okta address", required: true, env: "OKTA_URL", placeholder: "https://yourcompany.okta.com" },
      { key: "token", label: "API token", secret: true, required: true, env: "OKTA_TOKEN" },
      { key: "groupFilter", label: "Groups to read", env: "OKTA_GROUP_FILTER", placeholder: "IT-", hint: "Optional: only groups whose name starts with this." },
    ],
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    group: "Notifications",
    what: "Posts to a channel when a review is asked for or decided, and when someone shares a diagram.",
    access: "A workflow in the channel (Workflows → Post to a channel when a webhook request is received), and its address.",
    use: "notify",
    fields: [{ key: "webhookUrl", label: "Workflow webhook address", secret: true, required: true, env: "TEAMS_WEBHOOK_URL", placeholder: "https://...logic.azure.com/... or https://...powerplatform.com/..." }],
  },
  {
    id: "slack",
    label: "Slack",
    group: "Notifications",
    what: "Posts to a channel when a review is asked for or decided, and when someone shares a diagram.",
    access: "An incoming webhook for the channel, from a Slack app.",
    use: "notify",
    fields: [{ key: "webhookUrl", label: "Incoming webhook address", secret: true, required: true, env: "SLACK_WEBHOOK_URL", placeholder: "https://hooks.slack.com/services/..." }],
  },
  {
    id: "email",
    label: "Email",
    group: "Notifications",
    what: "Emails the people you list when a review is asked for or decided, and when someone shares a diagram.",
    access: "An API key from the email service, and a sender address on a domain verified there.",
    use: "notify",
    fields: [
      { key: "service", label: "Email service", required: true, env: "EMAIL_SERVICE", options: EMAIL_SERVICES },
      { key: "apiKey", label: "API key", secret: true, required: true, env: "EMAIL_API_KEY" },
      { key: "domain", label: "Mailgun domain", env: "EMAIL_DOMAIN", when: { key: "service", values: ["mailgun"] }, placeholder: "mg.example.com" },
      { key: "region", label: "Mailgun region", env: "EMAIL_REGION", when: { key: "service", values: ["mailgun"] }, options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] },
      { key: "from", label: "Sender", required: true, env: "EMAIL_FROM", placeholder: "ArchONE <architecture@example.com>" },
      { key: "to", label: "Recipients", required: true, env: "EMAIL_TO", placeholder: "architects@example.com, cto@example.com", hint: "Separated by commas, at most 20." },
    ],
  },
  {
    id: "jira",
    label: "Jira",
    group: "Work tracking",
    what: "Creates an issue from a decision record or a review, and links it back.",
    access: "A Jira Cloud user's email and API token, allowed to create issues in the project.",
    use: "issues",
    fields: [
      { key: "url", label: "Jira address", required: true, env: "JIRA_URL", placeholder: "https://yourcompany.atlassian.net" },
      { key: "email", label: "User email", required: true, env: "JIRA_EMAIL" },
      { key: "token", label: "API token", secret: true, required: true, env: "JIRA_TOKEN" },
      { key: "project", label: "Project key", required: true, env: "JIRA_PROJECT", placeholder: "ARCH" },
      { key: "issueType", label: "Issue type", env: "JIRA_ISSUE_TYPE", placeholder: "Task" },
    ],
  },
  {
    id: "azure-devops",
    label: "Azure DevOps Boards",
    group: "Work tracking",
    what: "Creates a work item from a decision record or a review, and links it back.",
    access: "A personal access token with Work Items (read and write).",
    use: "issues",
    fields: [
      { key: "organization", label: "Organization", required: true, env: "ADO_ORGANIZATION", placeholder: "yourcompany" },
      { key: "project", label: "Project", required: true, env: "ADO_PROJECT" },
      { key: "token", label: "Personal access token", secret: true, required: true, env: "ADO_TOKEN" },
      { key: "workItemType", label: "Work item type", env: "ADO_WORK_ITEM_TYPE", placeholder: "Task" },
    ],
  },
  {
    id: "confluence",
    label: "Confluence",
    group: "Documentation",
    what: "Publishes a diagram as a page, with its picture and the list of what is on it.",
    access: "A Confluence Cloud user's email and API token, allowed to add pages to the space.",
    use: "publish",
    fields: [
      { key: "url", label: "Confluence address", required: true, env: "CONFLUENCE_URL", placeholder: "https://yourcompany.atlassian.net/wiki" },
      { key: "email", label: "User email", required: true, env: "CONFLUENCE_EMAIL" },
      { key: "token", label: "API token", secret: true, required: true, env: "CONFLUENCE_TOKEN" },
      { key: "space", label: "Space key", required: true, env: "CONFLUENCE_SPACE", placeholder: "ARCH" },
      { key: "parentId", label: "Parent page ID", env: "CONFLUENCE_PARENT", hint: "Optional: the page the diagrams go under." },
    ],
  },
];

export const integrationOf = (id: unknown) => INTEGRATIONS.find((i) => i.id === id);

/** The server settings an integration stands for, from what is kept: for the connectors. */
export function integrationEnv(id: IntegrationId, settings: Record<string, unknown>, secrets: Record<string, unknown>): Record<string, string> {
  const def = integrationOf(id);
  const env: Record<string, string> = {};
  for (const field of def?.fields ?? []) {
    const raw = field.secret ? secrets[field.key] : settings[field.key];
    if (typeof raw === "string" && raw.trim()) env[field.env] = raw.trim();
  }
  return env;
}

/** Splits what a form holds into what is kept in the open and what is kept in the vault. */
export function splitFields(id: IntegrationId, values: Record<string, string>): { settings: Record<string, string>; secrets: Record<string, string> } {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of integrationOf(id)?.fields ?? []) {
    if (!fieldShown(field, values)) continue;
    const v = (values[field.key] ?? "").trim();
    if (field.secret) {
      if (v) secrets[field.key] = v;
    } else if (v) settings[field.key] = v;
  }
  return { settings, secrets };
}

/** Whether a field applies, given what the others hold (a Mailgun domain only for Mailgun). */
export const fieldShown = (field: IntegrationField, values: Record<string, string>) => !field.when || field.when.values.includes((values[field.when.key] ?? "").trim());

/** The required fields still missing, counting a secret that is already kept as present. */
export function missingFields(id: IntegrationId, values: Record<string, string>, keptSecrets: string[]): IntegrationField[] {
  const def = integrationOf(id);
  if (!def) return [];
  const has = (f: IntegrationField) => !!(values[f.key] ?? "").trim() || (!!f.secret && keptSecrets.includes(f.key));
  const missing = def.fields.filter((f) => fieldShown(f, values) && (f.required || f.when) && !has(f) && !(f.key === "region"));
  // ServiceNow takes either a token or a user name and password.
  if (id === "servicenow") {
    const field = (k: string) => def.fields.find((f) => f.key === k)!;
    if (!has(field("token")) && !(has(field("user")) && has(field("password")))) missing.push(...(!has(field("user")) ? [field("user")] : []), ...(!has(field("password")) ? [field("password")] : []));
  }
  return missing;
}

export interface IntegrationInfo {
  provider: IntegrationId;
  enabled: boolean;
  /** Only for owners and editors. */
  settings: Record<string, string>;
  /** Which secret fields are kept: never their values. */
  secretFields: string[];
  status: "untested" | "ok" | "failed";
  statusMessage: string;
  checkedAt: string | null;
  changedAt: string | null;
}
