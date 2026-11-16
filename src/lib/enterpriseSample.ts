import { protocolByName } from "./library/protocols";
import { LIBRARY_SECTIONS, exactComponent } from "./library";
import { createDiagram, createObject, createRelationship, diagramBox, setProtocols, updateObject, updateRelationship, type ObjectInput } from "./model";
import type { Provenance, RelationKind, ViewType, Workspace } from "./types";
import { addObjectsToDiagram, relayout } from "./views";

/**
 * Ten connected diagrams of one bank, for trying impact and dependency analysis on something
 * the size of a real estate: shared services (Active Directory, DNS, email, SIEM, backup), a
 * network with zones, protocols and ports on the connections, and boxes that stand for other
 * diagrams. Every object carries the tag "enterprise-sample".
 */

export const SAMPLE_TAG = "enterprise-sample";

export const SAMPLE_DIAGRAMS = [
  "Enterprise landscape",
  "Customer portal",
  "Core banking",
  "Payments hub",
  "Identity and access",
  "Data platform",
  "Data centre network",
  "Security operations",
  "Backup and disaster recovery",
  "Employee onboarding",
] as const;

type Spec = Omit<ObjectInput, "parentId" | "provenance" | "tags"> & { parent?: string; tags?: string[]; tier1?: boolean; criticality?: "Critical" | "High" | "Medium" | "Low" };
interface LinkSpec {
  from: string;
  to: string;
  kind?: RelationKind;
  label?: string;
  protocols?: string[];
  flow?: "out" | "in" | "both";
  network?: string;
  encrypted?: "yes" | "no";
}

export function hasEnterpriseSample(ws: Workspace): boolean {
  return Object.values(ws.objects).some((o) => o.tags.includes(SAMPLE_TAG));
}

export function addEnterpriseSample(input: Workspace): { ws: Workspace; diagrams: string[]; added: boolean } {
  if (hasEnterpriseSample(input)) return { ws: input, diagrams: [], added: false };
  let ws = input;
  const provenance: Provenance = { origin: "demo" };
  const ids: Record<string, string> = {};

  const add = (key: string, spec: Spec) => {
    const { parent, tags = [], tier1, criticality, fields = {}, ...rest } = spec;
    // A technology names a product; a cloud provider's version of it is not what runs here.
    const byTechnology = rest.technology ? exactComponent(rest.technology) : undefined;
    const component = exactComponent(rest.name) ?? (byTechnology && !LIBRARY_SECTIONS.find((x) => x.id === byTechnology.sectionId)?.provider ? byTechnology : undefined);
    const made = createObject(ws, {
      ...rest,
      componentId: rest.componentId ?? component?.id,
      parentId: parent ? ids[parent] : null,
      tags: [SAMPLE_TAG, ...tags, ...(tier1 ? ["tier-1"] : [])],
      fields: { ...fields, ...(criticality ? { "Business criticality": criticality } : {}) },
      provenance,
    });
    ws = made.ws;
    ids[key] = made.object.id;
  };
  const link = (l: LinkSpec) => {
    const made = createRelationship(ws, { sourceId: ids[l.from], targetId: ids[l.to], kind: l.kind ?? "calls", label: l.label ?? "", provenance });
    ws = made.ws;
    const r = made.relationship;
    if (!r) return;
    if (l.protocols?.length) ws = setProtocols(ws, r.id, l.protocols.map((name) => protocolByName(name) ?? { name, port: "" }).map((p) => ({ name: p.name, port: p.port, transport: "transport" in p ? p.transport : undefined })));
    if (l.flow || l.network || l.encrypted) ws = updateRelationship(ws, r.id, { flow: l.flow, network: l.network, encrypted: l.encrypted });
  };
  const L = (from: string, to: string, kind: RelationKind = "calls", protocols: string[] = [], extra: Partial<LinkSpec> = {}) => link({ from, to, kind, protocols, ...extra });

  /* ---------- people and external parties ---------- */
  add("customer", { typeId: "actor", name: "Retail customer", description: "Banks online and on the phone." });
  add("staff", { typeId: "actor", name: "Branch staff", description: "Serve customers in branches." });
  add("hr", { typeId: "actor", name: "HR officer", description: "Hires and onboards employees." });
  add("soc", { typeId: "actor", name: "SOC analyst", description: "Watches alerts and responds to incidents." });
  add("rtgs", { typeId: "external-system", name: "Central bank RTGS", description: "Real-time gross settlement between banks.", tags: ["regulated"], criticality: "Critical" });
  add("cardScheme", { typeId: "external-system", name: "Card scheme", description: "Visa and Mastercard authorisation network.", tags: ["pci"] });
  add("swift", { typeId: "external-system", name: "SWIFT network", description: "Cross-border payment messages." });
  add("sms", { typeId: "external-system", name: "SMS gateway", description: "One-time passwords and alerts to customers." });
  add("bureau", { typeId: "external-system", name: "Credit bureau", description: "Credit scores for loan decisions." });

  /* ---------- systems and their parts ---------- */
  add("portal", { typeId: "system", name: "Customer portal", owner: "Digital channels", tier1: true, criticality: "Critical", description: "Web and mobile banking." });
  add("web", { typeId: "web-app", name: "Online banking web", parent: "portal", owner: "Digital channels", technology: "React" });
  add("app", { typeId: "mobile-app", name: "Mobile banking app", parent: "portal", owner: "Digital channels", technology: "Flutter" });
  add("apigw", { typeId: "gateway", name: "API gateway", parent: "portal", owner: "Platform team", technology: "Kong", tier1: true });
  add("bff", { typeId: "service", name: "Portal API", parent: "portal", owner: "Digital channels", technology: "Java Spring" });
  add("notify", { typeId: "service", name: "Notification service", parent: "portal", owner: "Digital channels", technology: "Node.js" });
  add("session", { typeId: "cache", name: "Session store", parent: "portal", owner: "Platform team", technology: "Redis" });
  add("portalDb", { typeId: "database", name: "Portal database", parent: "portal", owner: "Digital channels", technology: "PostgreSQL" });

  add("core", { typeId: "system", name: "Core banking", owner: "Core banking team", tier1: true, criticality: "Critical", description: "Accounts, deposits, loans and the general ledger." });
  add("coreApp", { typeId: "application", name: "Core banking engine", parent: "core", owner: "Core banking team", technology: "Temenos Transact", tier1: true });
  add("coreApi", { typeId: "service", name: "Core banking API", parent: "core", owner: "Core banking team", technology: "Java" });
  add("coreDb", { typeId: "database", name: "Core banking database", parent: "core", owner: "Database team", technology: "Oracle", tier1: true, criticality: "Critical" });
  add("batch", { typeId: "service", name: "End-of-day batch", parent: "core", owner: "Core banking team", technology: "Control-M" });
  add("teller", { typeId: "web-app", name: "Teller workstation", parent: "core", owner: "Core banking team", technology: "Angular" });
  add("esb", { typeId: "queue", name: "Integration bus", owner: "Integration team", technology: "Kafka", tier1: true, criticality: "High", description: "Events and messages between core systems." });

  add("payments", { typeId: "system", name: "Payments hub", owner: "Payments team", tier1: true, criticality: "Critical", description: "Domestic, card and cross-border payments." });
  add("payEngine", { typeId: "service", name: "Payment engine", parent: "payments", owner: "Payments team", technology: "Java", tags: ["pci"] });
  add("fraud", { typeId: "service", name: "Fraud screening", parent: "payments", owner: "Risk team", technology: "Python" });
  add("swiftGw", { typeId: "service", name: "SWIFT gateway", parent: "payments", owner: "Payments team", technology: "SWIFT Alliance" });
  add("cardSwitch", { typeId: "service", name: "Card switch", parent: "payments", owner: "Payments team", technology: "BASE24", tags: ["pci"] });
  add("payDb", { typeId: "database", name: "Payments database", parent: "payments", owner: "Database team", technology: "Microsoft SQL Server", criticality: "High" });
  add("hsm", { typeId: "network", name: "Hardware security module", owner: "Security team", technology: "Thales payShield", tags: ["pci"], criticality: "Critical" });

  add("iam", { typeId: "system", name: "Identity and access", owner: "Identity team", tier1: true, criticality: "Critical", description: "Directory, sign-in and privileged access for everyone." });
  add("ad", { typeId: "service", name: "Active Directory", parent: "iam", owner: "Identity team", technology: "Windows Server 2022", tier1: true, criticality: "Critical" });
  add("sso", { typeId: "service", name: "Single sign-on", parent: "iam", owner: "Identity team", technology: "Keycloak", criticality: "High" });
  add("mfa", { typeId: "service", name: "Multi-factor authentication", parent: "iam", owner: "Identity team", technology: "Microsoft Entra ID" });
  add("pam", { typeId: "service", name: "Privileged access", parent: "iam", owner: "Security team", technology: "CyberArk" });
  add("pki", { typeId: "service", name: "Certificate authority", parent: "iam", owner: "Security team", technology: "Microsoft AD CS" });
  add("dns", { typeId: "service", name: "DNS", owner: "Network team", technology: "Infoblox", criticality: "Critical" });
  add("dhcp", { typeId: "service", name: "DHCP", owner: "Network team", technology: "Infoblox" });
  add("ntp", { typeId: "service", name: "NTP", owner: "Network team" });
  add("email", { typeId: "application", name: "Microsoft Exchange", owner: "Workplace team", technology: "Exchange Server 2019", criticality: "High" });
  add("hrSys", { typeId: "system", name: "HR system", owner: "HR", technology: "SAP SuccessFactors", description: "Employees, contracts and leavers." });
  add("itsm", { typeId: "system", name: "ServiceNow", owner: "IT service management", description: "Requests, incidents and changes." });
  add("crm", { typeId: "system", name: "CRM", owner: "Sales", technology: "Microsoft Dynamics 365", criticality: "High" });

  add("data", { typeId: "system", name: "Data platform", owner: "Data team", criticality: "High", description: "Reporting, regulatory returns and analytics." });
  add("cdc", { typeId: "service", name: "Change data capture", parent: "data", owner: "Data team", technology: "Debezium" });
  add("etl", { typeId: "service", name: "ETL pipelines", parent: "data", owner: "Data team", technology: "Informatica" });
  add("lake", { typeId: "storage", name: "Data lake", parent: "data", owner: "Data team", technology: "MinIO" });
  add("dwh", { typeId: "database", name: "Data warehouse", parent: "data", owner: "Data team", technology: "Snowflake", criticality: "High" });
  add("bi", { typeId: "web-app", name: "Power BI", parent: "data", owner: "Data team" });
  add("reg", { typeId: "service", name: "Regulatory reporting", parent: "data", owner: "Finance", technology: "Wolters Kluwer OneSumX", criticality: "High" });

  /* ---------- network: zones and what sits in them ---------- */
  add("zInternet", { typeId: "zone", name: "Internet", componentId: "zones.public-internet", owner: "Network team" });
  add("zDmz", { typeId: "zone", name: "DMZ", componentId: "zones.dmz", owner: "Network team" });
  add("zLan", { typeId: "zone", name: "Internal LAN", componentId: "zones.internal-lan", owner: "Network team" });
  add("zDb", { typeId: "zone", name: "Database zone", componentId: "zones.database-zone", owner: "Network team" });
  add("zPci", { typeId: "zone", name: "PCI zone", componentId: "zones.restricted-pci", owner: "Network team" });
  add("zMgmt", { typeId: "zone", name: "Management network", componentId: "zones.management", owner: "Network team" });
  add("zDr", { typeId: "zone", name: "DR site", componentId: "zones.dr-zone", owner: "Network team" });
  add("isp", { typeId: "network", name: "Internet link", parent: "zInternet", owner: "Network team", technology: "Dual ISP" });
  add("edgeFw", { typeId: "network", name: "Edge firewall", parent: "zDmz", owner: "Network team", technology: "Palo Alto PA-5450", tier1: true, criticality: "Critical" });
  add("waf", { typeId: "gateway", name: "Web application firewall", parent: "zDmz", owner: "Security team", technology: "F5 Advanced WAF" });
  add("lb", { typeId: "gateway", name: "Load balancer", parent: "zDmz", owner: "Network team", technology: "F5 BIG-IP", tier1: true });
  add("vpn", { typeId: "network", name: "VPN gateway", parent: "zDmz", owner: "Network team", technology: "FortiGate" });
  add("coreSw", { typeId: "network", name: "Core switch", parent: "zLan", owner: "Network team", technology: "Cisco Nexus 9000", tier1: true, criticality: "Critical" });
  add("intFw", { typeId: "network", name: "Internal firewall", parent: "zLan", owner: "Network team", technology: "Fortinet FortiGate" });
  add("mpls", { typeId: "network", name: "MPLS router", parent: "zLan", owner: "Network team", technology: "Cisco ASR", description: "Links the branches." });
  add("gsn", { typeId: "network", name: "GSN link", parent: "zLan", owner: "Network team", description: "Government secure network to the central bank." });
  add("dc1", { typeId: "server", name: "Domain controller 1", parent: "zLan", owner: "Identity team", technology: "Windows Server 2022", tier1: true });
  add("dc2", { typeId: "server", name: "Domain controller 2", parent: "zDr", owner: "Identity team", technology: "Windows Server 2022" });
  add("appCluster", { typeId: "cluster", name: "Application cluster", parent: "zLan", owner: "Platform team", technology: "OpenShift", tier1: true, criticality: "Critical" });
  add("dbCluster", { typeId: "server", name: "Oracle RAC cluster", parent: "zDb", owner: "Database team", technology: "Oracle Exadata", tier1: true, criticality: "Critical" });
  add("sqlCluster", { typeId: "server", name: "SQL Server cluster", parent: "zPci", owner: "Database team", technology: "Always On", tags: ["pci"] });
  add("jump", { typeId: "server", name: "Jump servers", parent: "zMgmt", owner: "Security team", technology: "Windows Server 2022" });
  add("drDb", { typeId: "server", name: "DR database", parent: "zDr", owner: "Database team", technology: "Oracle Data Guard", criticality: "High" });

  /* ---------- security operations ---------- */
  add("siem", { typeId: "application", name: "Splunk", owner: "Security team", technology: "Splunk Enterprise Security", criticality: "High", description: "Security event collection and correlation." });
  add("collector", { typeId: "server", name: "Log collectors", parent: "zMgmt", owner: "Security team", technology: "Splunk heavy forwarder" });
  add("edr", { typeId: "service", name: "Endpoint protection", owner: "Security team", technology: "CrowdStrike Falcon" });
  add("soar", { typeId: "service", name: "Security automation", owner: "Security team", technology: "Splunk SOAR" });

  /* ---------- backup and recovery ---------- */
  add("backup", { typeId: "application", name: "Veeam Backup", owner: "Infrastructure team", technology: "Veeam Backup & Replication", criticality: "High" });
  add("repo", { typeId: "storage", name: "Backup repository", parent: "zDr", owner: "Infrastructure team", technology: "Dell Data Domain" });
  add("vault", { typeId: "storage", name: "Immutable copy", owner: "Infrastructure team", technology: "Object storage with object lock", description: "Copies that ransomware cannot change." });

  /* ---------- employee onboarding, as a process ---------- */
  add("onboard", { typeId: "process", name: "Onboard an employee", owner: "HR", description: "From signed contract to ready on day one." });
  add("eStart", { typeId: "event", name: "Contract signed", parent: "onboard" });
  add("tRecord", { typeId: "task", name: "Create employee record", parent: "onboard" });
  add("tAccount", { typeId: "task", name: "Create directory account", parent: "onboard" });
  add("tMail", { typeId: "task", name: "Create mailbox", parent: "onboard" });
  add("dPriv", { typeId: "decision", name: "Needs privileged access?", parent: "onboard" });
  add("tPam", { typeId: "task", name: "Grant privileged access", parent: "onboard" });
  add("tLaptop", { typeId: "task", name: "Issue laptop", parent: "onboard" });
  add("eEnd", { typeId: "event", name: "Ready on day one", parent: "onboard" });

  /* ---------- relationships ---------- */
  // Channels.
  L("customer", "web", "calls", ["HTTPS"], { network: "Internet" });
  L("customer", "app", "calls", ["HTTPS"], { network: "Internet" });
  L("web", "apigw", "calls", ["HTTPS"]);
  L("app", "apigw", "calls", ["HTTPS"]);
  L("apigw", "bff", "routes_to", ["HTTPS"]);
  L("bff", "sso", "depends_on", ["OpenID Connect"], { label: "signs customers in with" });
  L("bff", "session", "reads_writes", ["Redis over TLS"]);
  L("bff", "portalDb", "reads_writes", ["PostgreSQL"], { encrypted: "yes" });
  L("bff", "coreApi", "calls", ["HTTPS"], { label: "balances and transfers" });
  L("bff", "payEngine", "calls", ["HTTPS"], { label: "payments" });
  L("bff", "notify", "calls", ["gRPC"]);
  L("notify", "sms", "calls", ["SMPP"], { network: "Internet" });
  L("notify", "email", "calls", ["SMTP submission"]);
  L("bff", "crm", "calls", ["REST"], { label: "customer profile" });
  // Core banking.
  L("staff", "teller", "calls", ["HTTPS"], { network: "MPLS" });
  L("teller", "coreApi", "calls", ["HTTPS"]);
  L("teller", "ad", "depends_on", ["Kerberos", "LDAPS"], { label: "staff sign in" });
  L("coreApi", "coreApp", "calls", ["IBM MQ"]);
  L("coreApp", "coreDb", "reads_writes", ["Oracle Net (TNS)"], { encrypted: "yes" });
  L("batch", "coreApp", "calls", ["IBM MQ"]);
  L("batch", "coreDb", "reads_writes", ["Oracle Net (TNS)"]);
  L("coreApp", "esb", "calls", ["Kafka over TLS"], { flow: "both", label: "events" });
  L("coreApp", "bureau", "calls", ["HTTPS"], { network: "Internet", label: "credit checks" });
  // Payments.
  L("payEngine", "fraud", "calls", ["gRPC"]);
  L("payEngine", "payDb", "reads_writes", ["Microsoft SQL Server"], { encrypted: "yes" });
  L("payEngine", "coreApi", "calls", ["HTTPS"], { label: "posts to accounts" });
  L("payEngine", "esb", "calls", ["Kafka over TLS"]);
  L("payEngine", "swiftGw", "calls", ["IBM MQ"]);
  L("payEngine", "rtgs", "calls", ["ISO 20022"], { network: "GSN", label: "settles" });
  L("swiftGw", "swift", "calls", ["SWIFT FIN (MT)", "ISO 20022"], { network: "SWIFTNet" });
  L("cardSwitch", "cardScheme", "calls", ["ISO 8583"], { network: "MPLS", flow: "both" });
  L("cardSwitch", "hsm", "depends_on", ["HTTPS"], { label: "PIN and key operations" });
  L("payEngine", "hsm", "depends_on", ["HTTPS"]);
  L("cardSwitch", "payEngine", "calls", ["IBM MQ"]);
  // Identity and shared services.
  L("sso", "ad", "depends_on", ["LDAPS"]);
  L("sso", "mfa", "calls", ["HTTPS"]);
  L("pam", "ad", "depends_on", ["LDAPS"]);
  L("mfa", "ad", "depends_on", ["LDAPS"], { label: "syncs users" });
  L("ad", "dns", "depends_on", ["DNS"]);
  L("ad", "ntp", "depends_on", ["NTP"]);
  L("ad", "pki", "calls", ["RPC endpoint mapper"], { label: "certificates" });
  L("email", "ad", "depends_on", ["LDAPS", "Kerberos"]);
  L("email", "dns", "depends_on", ["DNS"]);
  L("crm", "sso", "depends_on", ["SAML"]);
  L("crm", "esb", "calls", ["Kafka over TLS"]);
  L("hrSys", "ad", "calls", ["LDAPS"], { label: "provisions accounts" });
  L("itsm", "ad", "depends_on", ["LDAPS"]);
  L("itsm", "email", "calls", ["SMTP submission"]);
  // Data platform.
  L("cdc", "coreDb", "reads_writes", ["Oracle Net (TNS)"], { label: "reads the redo log" });
  L("cdc", "esb", "calls", ["Kafka over TLS"]);
  L("etl", "esb", "calls", ["Kafka over TLS"], { label: "consumes events" });
  L("etl", "payDb", "reads_writes", ["Microsoft SQL Server"]);
  L("etl", "crm", "calls", ["REST"]);
  L("etl", "lake", "reads_writes", ["S3 API"]);
  L("etl", "dwh", "reads_writes", ["HTTPS"]);
  L("bi", "dwh", "reads_writes", ["HTTPS"]);
  L("bi", "sso", "depends_on", ["SAML"]);
  L("reg", "dwh", "reads_writes", ["HTTPS"]);
  L("reg", "rtgs", "calls", ["SFTP"], { network: "GSN", label: "regulatory returns" });
  // Hosting and the network.
  for (const k of ["apigw", "bff", "notify", "coreApi", "payEngine", "fraud", "sso", "etl", "cdc", "reg"]) L(k, "appCluster", "hosted_on");
  L("coreApp", "appCluster", "hosted_on");
  L("coreDb", "dbCluster", "hosted_on");
  L("payDb", "sqlCluster", "hosted_on");
  L("cardSwitch", "sqlCluster", "hosted_on");
  L("ad", "dc1", "hosted_on");
  L("ad", "dc2", "hosted_on");
  L("isp", "edgeFw", "routes_to", ["HTTPS"]);
  L("edgeFw", "waf", "routes_to", ["HTTPS"]);
  L("waf", "lb", "routes_to", ["HTTPS"]);
  L("lb", "apigw", "routes_to", ["HTTPS"]);
  L("lb", "appCluster", "depends_on", ["HTTPS"]);
  L("edgeFw", "vpn", "routes_to", ["SSL VPN", "IPsec IKE"]);
  L("edgeFw", "coreSw", "depends_on", [], { label: "uplink" });
  L("intFw", "coreSw", "depends_on", []);
  L("appCluster", "coreSw", "depends_on", [], { label: "25G uplinks" });
  L("dbCluster", "intFw", "depends_on", ["Oracle Net (TNS)"]);
  L("sqlCluster", "intFw", "depends_on", ["Microsoft SQL Server"]);
  L("mpls", "coreSw", "depends_on", ["BGP"], { network: "MPLS" });
  L("gsn", "coreSw", "depends_on", ["IPsec ESP"], { network: "GSN" });
  L("dc1", "coreSw", "depends_on", []);
  L("jump", "pam", "depends_on", ["RDP", "SSH"], { label: "sessions brokered by" });
  L("dbCluster", "drDb", "replicates_to", ["Oracle Net (TNS)"], { network: "Dark fibre", encrypted: "yes" });
  L("drDb", "coreSw", "depends_on", []);
  L("coreSw", "dns", "depends_on", ["DNS"]);
  L("coreSw", "dhcp", "depends_on", ["DHCP server"]);
  L("coreSw", "ntp", "depends_on", ["NTP"]);
  L("dns", "dc1", "hosted_on");
  // Security operations.
  L("soc", "siem", "calls", ["HTTPS"]);
  L("collector", "siem", "calls", ["HTTPS"], { label: "forwards events" });
  L("edgeFw", "collector", "calls", ["Syslog over TLS"], { label: "logs" });
  L("ad", "collector", "calls", ["Syslog over TLS"], { label: "logs" });
  L("coreApp", "collector", "calls", ["Syslog over TLS"], { label: "audit trail" });
  L("payEngine", "collector", "calls", ["Syslog over TLS"]);
  L("pam", "collector", "calls", ["Syslog"]);
  L("edr", "siem", "calls", ["HTTPS"]);
  L("soar", "siem", "depends_on", ["HTTPS"]);
  L("soar", "itsm", "calls", ["REST"], { label: "opens incidents" });
  L("soar", "edr", "calls", ["REST"], { label: "isolates hosts" });
  L("siem", "ad", "depends_on", ["LDAPS"]);
  L("siem", "email", "calls", ["SMTP submission"], { label: "alerts" });
  // Backup and recovery.
  L("backup", "coreDb", "reads_writes", ["Oracle Net (TNS)"], { label: "RMAN backups" });
  L("backup", "payDb", "reads_writes", ["Microsoft SQL Server"]);
  L("backup", "dc1", "reads_writes", ["SMB"]);
  L("backup", "email", "reads_writes", ["Exchange Web Services"]);
  L("backup", "repo", "reads_writes", ["NFS"], { network: "Dark fibre" });
  L("repo", "vault", "replicates_to", ["S3 API"], { encrypted: "yes" });
  L("backup", "ad", "depends_on", ["LDAPS"]);
  L("backup", "collector", "calls", ["Syslog"]);
  // Onboarding, as a flow, and the systems each step uses.
  L("eStart", "tRecord", "flows_to");
  L("tRecord", "tAccount", "flows_to");
  L("tAccount", "tMail", "flows_to");
  L("tMail", "dPriv", "flows_to");
  L("dPriv", "tPam", "flows_to", [], { label: "yes" });
  L("dPriv", "tLaptop", "flows_to", [], { label: "no" });
  L("tPam", "tLaptop", "flows_to");
  L("tLaptop", "eEnd", "flows_to");
  L("hr", "tRecord", "calls");
  L("tRecord", "hrSys", "depends_on");
  L("tAccount", "ad", "depends_on");
  L("tMail", "email", "depends_on");
  L("tPam", "pam", "depends_on");
  L("tLaptop", "itsm", "depends_on");

  /* ---------- the ten diagrams ---------- */
  const made: string[] = [];
  const diagram = (name: string, viewType: ViewType, keys: string[], options: { scope?: string; direction?: "TB" | "LR"; description: string }) => {
    const d = createDiagram(ws, { name, viewType, scopeId: options.scope ? ids[options.scope] : null, direction: options.direction ?? "TB", description: `${options.description} Part of the enterprise sample.` });
    ws = addObjectsToDiagram(d.ws, d.diagram.id, keys.map((k) => ids[k]).filter(Boolean));
    made.push(d.diagram.id);
    return d.diagram.id;
  };
  const withBox = (diagramId: string, standsFor: string) => {
    const box = diagramBox(ws, standsFor);
    ws = box.ws;
    if (box.objectId) {
      const o = ws.objects[box.objectId];
      if (!o.tags.includes(SAMPLE_TAG)) ws = updateObject(ws, o.id, { tags: [...o.tags, SAMPLE_TAG] });
      ws = addObjectsToDiagram(ws, diagramId, [box.objectId]);
      ids[`box:${standsFor}`] = box.objectId;
    }
    return box.objectId;
  };

  const landscape = diagram("Enterprise landscape", "landscape", ["customer", "staff", "hr", "portal", "core", "payments", "iam", "data", "crm", "hrSys", "itsm", "email", "esb", "rtgs", "swift", "cardScheme", "sms", "bureau"], {
    description: "Every system of the bank and who uses it.",
  });
  // The landscape's systems talk through their parts; say so at this level too.
  L("customer", "portal", "calls", ["HTTPS"]);
  L("staff", "core", "calls", ["HTTPS"]);
  L("portal", "core", "calls", ["HTTPS"]);
  L("portal", "payments", "calls", ["HTTPS"]);
  L("portal", "iam", "depends_on", ["OpenID Connect"]);
  L("payments", "core", "calls", ["HTTPS"]);
  L("core", "esb", "calls", ["Kafka over TLS"]);
  L("data", "core", "reads_writes", ["Oracle Net (TNS)"]);
  L("data", "esb", "calls", ["Kafka over TLS"]);
  L("core", "iam", "depends_on", ["Kerberos"]);
  L("payments", "iam", "depends_on", ["LDAPS"]);
  L("payments", "rtgs", "calls", ["ISO 20022"], { network: "GSN" });
  L("payments", "swift", "calls", ["SWIFT FIN (MT)"]);
  L("payments", "cardScheme", "calls", ["ISO 8583"]);
  L("portal", "sms", "calls", ["SMPP"]);
  L("core", "bureau", "calls", ["HTTPS"]);
  L("data", "rtgs", "calls", ["SFTP"]);
  const portalD = diagram("Customer portal", "container", ["customer", "web", "app", "apigw", "bff", "notify", "session", "portalDb", "sso", "coreApi", "payEngine", "crm", "sms", "email"], {
    scope: "portal",
    description: "Web and mobile banking, and what they call.",
  });
  const coreD = diagram("Core banking", "container", ["staff", "teller", "coreApi", "coreApp", "coreDb", "batch", "esb", "ad", "bureau", "collector"], { scope: "core", description: "Accounts and the ledger." });
  const paymentsD = diagram("Payments hub", "container", ["payEngine", "fraud", "swiftGw", "cardSwitch", "payDb", "hsm", "coreApi", "esb", "rtgs", "swift", "cardScheme", "collector"], { scope: "payments", description: "Domestic, card and cross-border payments." });
  const iamD = diagram("Identity and access", "container", ["ad", "sso", "mfa", "pam", "pki", "dns", "ntp", "dc1", "dc2", "email", "crm", "itsm", "hrSys", "collector"], { scope: "iam", description: "Directory, sign-in and privileged access." });
  const dataD = diagram("Data platform", "dataflow", ["coreDb", "payDb", "crm", "esb", "cdc", "etl", "lake", "dwh", "bi", "reg", "rtgs", "sso"], { direction: "LR", description: "From the source systems to reports and regulatory returns." });
  const networkD = diagram("Data centre network", "deployment", ["zInternet", "zDmz", "zLan", "zDb", "zPci", "zMgmt", "zDr", "isp", "edgeFw", "waf", "lb", "vpn", "coreSw", "intFw", "mpls", "gsn", "dc1", "dc2", "appCluster", "dbCluster", "sqlCluster", "jump", "drDb", "dns", "dhcp", "ntp", "collector"], {
    direction: "LR",
    description: "Zones, devices and links of the main data centre and the DR site.",
  });
  const socD = diagram("Security operations", "deployment", ["soc", "siem", "collector", "edr", "soar", "edgeFw", "ad", "coreApp", "payEngine", "pam", "itsm", "email", "backup"], { direction: "LR", description: "Where security events come from and who acts on them." });
  const backupD = diagram("Backup and disaster recovery", "deployment", ["backup", "repo", "vault", "coreDb", "payDb", "dc1", "email", "dbCluster", "drDb", "ad", "collector", "zDr"], { direction: "LR", description: "What is backed up, where copies go, and the DR site." });
  diagram("Employee onboarding", "business", ["hr", "onboard", "eStart", "tRecord", "tAccount", "tMail", "dPriv", "tPam", "tLaptop", "eEnd", "hrSys", "ad", "email", "pam", "itsm"], { direction: "LR", description: "From signed contract to ready on day one." });

  // Boxes that stand for whole diagrams, so dependencies cross from one to the next.
  const boxNetwork = withBox(portalD, networkD);
  if (boxNetwork) L("apigw", `box:${networkD}`, "depends_on", ["HTTPS"], { label: "published through" });
  ws = addObjectsToDiagram(ws, coreD, [ids[`box:${networkD}`]].filter(Boolean));
  L("coreApp", `box:${networkD}`, "hosted_on");
  const boxBackup = withBox(coreD, backupD);
  if (boxBackup) L("coreDb", `box:${backupD}`, "depends_on", [], { label: "recovered from" });
  const boxIam = withBox(dataD, iamD);
  if (boxIam) L("bi", `box:${iamD}`, "depends_on", ["SAML"]);
  if (withBox(landscape, networkD)) for (const k of ["portal", "core", "payments", "data"]) L(k, `box:${networkD}`, "hosted_on");
  withBox(socD, networkD);
  L("collector", `box:${networkD}`, "depends_on", ["Syslog over TLS"], { label: "collects from" });
  withBox(paymentsD, iamD);
  L("payEngine", `box:${iamD}`, "depends_on", ["LDAPS"]);

  for (const id of made) ws = relayout(ws, id, false);
  return { ws, diagrams: made, added: true };
}
