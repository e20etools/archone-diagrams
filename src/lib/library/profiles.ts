/**
 * The basic information each kind of component asks for. A server has a host name and a
 * serial number, a database an engine and a recovery point, a cloud service a region and an
 * account. The answers are kept in the object's fields under the field's label, so they move
 * with the object through versions, scenarios, exports and the API like any other field.
 */

export type FieldKind = "text" | "number" | "date" | "url" | "select" | "ip";

export interface ProfileField {
  label: string;
  kind: FieldKind;
  /** For a select. */
  options?: string[];
  /** Shown after a number, for example "GB". */
  unit?: string;
  placeholder?: string;
}

export interface Profile {
  id: string;
  label: string;
  fields: ProfileField[];
}

const t = (label: string, placeholder?: string): ProfileField => ({ label, kind: "text", ...(placeholder ? { placeholder } : {}) });
const n = (label: string, unit?: string): ProfileField => ({ label, kind: "number", ...(unit ? { unit } : {}) });
const d = (label: string): ProfileField => ({ label, kind: "date" });
const u = (label: string): ProfileField => ({ label, kind: "url", placeholder: "https://" });
const ip = (label: string): ProfileField => ({ label, kind: "ip", placeholder: "10.0.0.1" });
const s = (label: string, options: string[]): ProfileField => ({ label, kind: "select", options });

const ENVIRONMENT = s("Environment", ["Production", "Staging", "Test", "Development", "Disaster recovery"]);
const HOSTING = s("Hosting", ["On-premises", "Private cloud", "Public cloud", "SaaS", "Hybrid", "Colocation"]);
const CRITICALITY = s("Business criticality", ["Critical", "High", "Medium", "Low"]);
const SUPPORT_ENDS = d("Support ends");
const VENDOR = t("Vendor");
const PRODUCT = t("Product");
const VERSION = t("Version");
const SERIAL = t("Serial number");
const ASSET = t("Asset tag");
const LOCATION = t("Location", "Site, building, room or rack");
const MANUFACTURER = t("Manufacturer");
const MODEL = t("Model");
const WARRANTY = d("Warranty ends");
const OS = t("Operating system", "For example Windows Server 2022 or RHEL 9");
const CLOUD_COMMON = [
  t("Account or subscription", "Account, subscription, project or tenant"),
  t("Region", "For example me-central-1 or Saudi Arabia Central"),
  t("Resource ID", "ARN, resource ID or OCID"),
  t("Tier or SKU"),
  ENVIRONMENT,
  n("Monthly cost", "USD"),
];

export const PROFILES: Profile[] = [
  // Business and people
  { id: "capability", label: "Business capability", fields: [s("Capability level", ["L1", "L2", "L3"]), s("Maturity", ["1 Initial", "2 Repeatable", "3 Defined", "4 Managed", "5 Optimised"]), s("Strategic importance", ["High", "Medium", "Low"]), t("Business owner")] },
  { id: "process", label: "Business process", fields: [t("Process owner"), s("Frequency", ["Continuous", "Daily", "Weekly", "Monthly", "Quarterly", "Yearly", "On demand"]), t("Service level", "For example 2 working days"), CRITICALITY] },
  { id: "organisation", label: "Organisation", fields: [t("Department"), LOCATION, t("Contact email"), n("Headcount")] },
  { id: "location", label: "Location", fields: [t("Address"), t("City"), t("Country"), t("Time zone"), t("Site code")] },
  { id: "external", label: "External party", fields: [t("Organisation"), t("Agreement or contract"), t("Contact"), t("Service level"), t("Data shared"), u("Website")] },

  // Applications and software
  { id: "application", label: "Application", fields: [VENDOR, PRODUCT, VERSION, HOSTING, s("Licence type", ["Commercial", "Subscription", "Open source", "In-house", "Freeware"]), n("Users"), u("Address"), t("Business owner"), t("Technical owner"), t("Support contact"), CRITICALITY, SUPPORT_ENDS] },
  { id: "saas", label: "SaaS application", fields: [VENDOR, t("Plan or edition"), u("Tenant address"), n("Licences"), s("Single sign-on", ["Yes", "No"]), t("Data stored in", "Country or region"), d("Contract ends"), t("Business owner")] },
  { id: "middleware", label: "Platform or middleware", fields: [VENDOR, PRODUCT, VERSION, t("Edition"), t("Host"), n("Port"), s("Clustered", ["Yes", "No"]), ENVIRONMENT, SUPPORT_ENDS] },
  { id: "os", label: "Operating system or hypervisor", fields: [VENDOR, PRODUCT, VERSION, t("Edition"), s("Patch level", ["Current", "One behind", "Out of date", "Unknown"]), SUPPORT_ENDS] },
  { id: "api", label: "Interface", fields: [s("Style", ["REST", "SOAP", "GraphQL", "gRPC", "Events", "File", "Database link"]), u("Base address"), VERSION, s("Authentication", ["OAuth 2.0", "API key", "Mutual TLS", "Basic", "SAML", "None"]), t("Rate limit", "For example 100 per second"), u("Documentation"), t("Owner")] },
  { id: "messaging", label: "Messaging", fields: [PRODUCT, VERSION, t("Queues or topics"), n("Throughput", "messages/s"), t("Retention", "For example 7 days"), s("Delivery", ["At most once", "At least once", "Exactly once"]), ENVIRONMENT] },

  // Data
  { id: "database", label: "Database", fields: [t("Engine", "For example PostgreSQL or Oracle"), VERSION, t("Edition"), n("Size", "GB"), t("Host"), n("Port"), s("High availability", ["None", "Replica", "Cluster", "Always On", "Multi-region"]), t("Backup policy"), n("Recovery point", "hours"), n("Recovery time", "hours"), s("Encrypted at rest", ["Yes", "No"]), ENVIRONMENT] },
  { id: "dataset", label: "Data set", fields: [t("Data owner"), t("Steward"), s("Format", ["Table", "File", "Document", "Stream", "Report", "Model"]), t("Source system"), s("Refresh", ["Real time", "Hourly", "Daily", "Weekly", "Monthly", "Manual"]), t("Retention")] },
  { id: "storage", label: "Storage system", fields: [MANUFACTURER, MODEL, SERIAL, n("Raw capacity", "TB"), n("Usable capacity", "TB"), s("Access", ["Fibre Channel", "iSCSI", "NFS", "SMB", "S3", "NVMe-oF", "Local"]), t("RAID or protection"), t("Replication"), LOCATION, WARRANTY] },
  { id: "backup", label: "Backup", fields: [PRODUCT, t("Schedule", "For example daily at 01:00"), n("Retention", "days"), n("Recovery point", "hours"), n("Recovery time", "hours"), t("Copies kept at"), d("Last restore test")] },

  // Hardware and datacentre
  { id: "server", label: "Physical server", fields: [t("Host name"), MANUFACTURER, MODEL, SERIAL, ASSET, t("Processor"), n("Cores"), n("Memory", "GB"), OS, ip("IP address"), LOCATION, ENVIRONMENT, WARRANTY] },
  { id: "vm", label: "Virtual machine", fields: [t("Host name"), t("Runs on", "Host or cluster"), n("Virtual CPUs"), n("Memory", "GB"), n("Disk", "GB"), OS, ip("IP address"), ENVIRONMENT] },
  { id: "mainframe", label: "Mainframe or midrange", fields: [MANUFACTURER, MODEL, SERIAL, t("Operating system", "z/OS, IBM i, AIX"), n("Capacity", "MIPS"), t("Logical partitions"), LOCATION, SUPPORT_ENDS] },
  { id: "facility", label: "Data centre or site", fields: [t("Address"), t("City"), t("Country"), s("Tier", ["Tier I", "Tier II", "Tier III", "Tier IV", "Not rated"]), t("Operator"), n("Power capacity", "kW"), n("Floor space", "m²"), t("Certifications", "For example ISO 27001"), s("Role", ["Primary", "Secondary", "Disaster recovery", "Edge", "Colocation"])] },
  { id: "rack", label: "Rack or enclosure", fields: [LOCATION, t("Row and position"), n("Height", "U"), n("Used", "U"), n("Power budget", "kW"), t("Power feeds")] },
  { id: "power", label: "Power or cooling", fields: [MANUFACTURER, MODEL, SERIAL, n("Capacity", "kW"), n("Runtime on battery", "minutes"), LOCATION, d("Maintenance contract ends"), d("Last tested")] },

  // Network and security
  { id: "network-device", label: "Network device", fields: [t("Host name"), MANUFACTURER, MODEL, SERIAL, t("Firmware or OS version"), ip("Management IP"), n("Ports"), LOCATION, s("Role", ["Core", "Distribution", "Access", "Edge", "Data centre", "Branch"]), SUPPORT_ENDS] },
  { id: "network-segment", label: "Network or segment", fields: [t("Address range", "For example 10.20.0.0/16"), n("VLAN"), ip("Gateway"), s("Zone", ["Internet", "DMZ", "Internal", "Restricted", "Management", "Guest", "OT"]), t("Site")] },
  { id: "link", label: "Network link", fields: [t("Provider"), t("Circuit ID"), n("Bandwidth", "Mbps"), s("Type", ["MPLS", "Internet", "Dedicated fibre", "SD-WAN", "LTE or 5G", "Satellite", "Microwave"]), t("Site A"), t("Site B"), d("Contract ends")] },
  { id: "security-control", label: "Security control", fields: [VENDOR, PRODUCT, VERSION, s("Deployment", ["Inline appliance", "Out of band", "Agent", "Cloud service", "Virtual appliance"]), t("Protects", "What it covers"), t("Policy owner"), u("Management console"), d("Licence ends"), d("Last reviewed")] },
  { id: "identity", label: "Identity service", fields: [PRODUCT, VERSION, t("Directory or tenant"), t("Protocols", "SAML, OIDC, LDAP, Kerberos"), n("Accounts"), s("Multi-factor enforced", ["Yes", "Partly", "No"]), t("Owner")] },
  { id: "credential", label: "Key, secret or certificate", fields: [t("Issuer"), t("Algorithm", "For example RSA 3072 or ECDSA P-256"), d("Expires"), t("Stored in"), t("Used by"), t("Rotation", "For example every 90 days")] },

  // End user, communications, IoT
  { id: "end-user-device", label: "End-user device", fields: [MANUFACTURER, MODEL, SERIAL, ASSET, t("Assigned to"), OS, s("Managed", ["Yes", "No"]), s("Disk encrypted", ["Yes", "No"]), d("Purchased"), WARRANTY] },
  { id: "peripheral", label: "Peripheral", fields: [MANUFACTURER, MODEL, SERIAL, ASSET, ip("IP address"), LOCATION, t("Connected to")] },
  { id: "communication", label: "Communication service", fields: [VENDOR, PRODUCT, VERSION, n("Users or extensions"), t("Numbers or trunks"), t("Carrier"), HOSTING] },
  { id: "iot", label: "IoT or OT device", fields: [MANUFACTURER, MODEL, SERIAL, t("Firmware"), t("Protocol", "Modbus, OPC UA, MQTT, BACnet, Zigbee"), ip("IP address"), LOCATION, s("Safety critical", ["Yes", "No"]), s("Network zone", ["OT", "IT", "Isolated", "Cloud connected"])] },

  // Platforms
  { id: "container", label: "Container workload", fields: [t("Image"), t("Tag or version"), t("Namespace"), n("Replicas"), t("CPU limit"), t("Memory limit"), t("Cluster")] },
  { id: "kubernetes", label: "Container platform", fields: [t("Distribution", "For example OpenShift, EKS, AKS, Rancher"), VERSION, n("Nodes"), t("Site or region"), t("Ingress"), t("Service mesh"), ENVIRONMENT] },
  { id: "devops", label: "Engineering tool", fields: [PRODUCT, VERSION, u("Address"), t("Projects or repositories"), HOSTING, t("Owner")] },
  { id: "monitoring", label: "Monitoring or operations tool", fields: [PRODUCT, VERSION, u("Address"), t("What it watches"), t("Alerts go to"), n("Retention", "days"), HOSTING] },
  { id: "ai", label: "AI model or service", fields: [t("Provider"), t("Model and version", "For example claude-sonnet-5-5"), s("Hosted", ["Provider API", "Cloud platform", "Self-hosted", "On device"]), t("Purpose"), t("Data sent to it"), d("Last evaluated"), t("Owner")] },
  { id: "generic", label: "Component", fields: [VENDOR, PRODUCT, VERSION, t("Owner"), ENVIRONMENT, SUPPORT_ENDS] },

  // Cloud services
  { id: "cloud-service", label: "Cloud service", fields: CLOUD_COMMON },
  { id: "cloud-compute", label: "Cloud compute", fields: [...CLOUD_COMMON, t("Instance type or size"), OS, n("Instances"), s("Auto scaling", ["Yes", "No"])] },
  { id: "cloud-database", label: "Cloud database", fields: [...CLOUD_COMMON, t("Engine and version"), n("Storage", "GB"), s("High availability", ["Single zone", "Multi-zone", "Multi-region"]), n("Backup retention", "days"), s("Encrypted at rest", ["Yes", "No"])] },
  { id: "cloud-storage", label: "Cloud storage", fields: [...CLOUD_COMMON, t("Bucket, share or volume name"), n("Size", "GB"), s("Storage class", ["Hot", "Cool", "Archive", "Intelligent"]), s("Public access", ["Blocked", "Allowed"]), s("Versioning", ["On", "Off"])] },
  { id: "cloud-network", label: "Cloud network", fields: [...CLOUD_COMMON, t("Address range"), t("Connected to"), s("Exposed to the internet", ["Yes", "No"])] },
  { id: "cloud-container", label: "Cloud container platform", fields: [...CLOUD_COMMON, t("Version"), n("Nodes"), t("Node size")] },
  { id: "cloud-messaging", label: "Cloud messaging", fields: [...CLOUD_COMMON, t("Queues or topics"), t("Retention"), s("Delivery", ["At most once", "At least once", "Exactly once"])] },
  { id: "cloud-ai", label: "Cloud AI service", fields: [...CLOUD_COMMON, t("Model and version"), t("Purpose"), t("Data sent to it")] },
  { id: "cloud-security", label: "Cloud security service", fields: [...CLOUD_COMMON, t("Protects"), t("Policy owner")] },
];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));
export const profileById = (id: string): Profile => BY_ID.get(id) ?? BY_ID.get("generic")!;
export const hasProfile = (id: string) => BY_ID.has(id);
