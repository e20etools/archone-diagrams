/**
 * The protocols and ports connections use. A connection can carry several ("HTTPS 443/TCP" and
 * "SSH 22/TCP"); picking one here fills its name, port and transport. "Secure" says whether
 * the protocol itself encrypts what it carries, which the checks use to point out clear text.
 */

import type { LibraryItem } from "../types";

export type Transport = "TCP" | "UDP" | "TCP/UDP" | "IP" | "Other";

export interface ProtocolInfo {
  /** Stable for a built-in one ("proto.https.443"); the workspace's own have their own. */
  id: string;
  name: string;
  port: string;
  transport: Transport;
  group: string;
  secure: boolean;
  /** What it is for, in a few words. */
  use: string;
  /** The workspace's own. */
  custom?: boolean;
  /** A built-in protocol this workspace changed. */
  changed?: boolean;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "any";
const p = (group: string, name: string, port: string, transport: Transport, secure: boolean, use: string): ProtocolInfo => ({ id: `proto.${slug(name)}.${slug(port)}`, name, port, transport, group, secure, use });

/** The protocols as the app ships them. */
export const BUILT_IN_PROTOCOLS: readonly ProtocolInfo[] = [
  // Web and APIs
  p("Web and APIs", "HTTP", "80", "TCP", false, "Web pages and APIs in clear text"),
  p("Web and APIs", "HTTPS", "443", "TCP", true, "Web pages and APIs over TLS"),
  p("Web and APIs", "HTTP alternate", "8080", "TCP", false, "Application servers, proxies"),
  p("Web and APIs", "HTTPS alternate", "8443", "TCP", true, "Application servers, admin consoles"),
  p("Web and APIs", "HTTP/3 (QUIC)", "443", "UDP", true, "Fast web over QUIC"),
  p("Web and APIs", "WebSocket", "80", "TCP", false, "Two-way browser connections"),
  p("Web and APIs", "WebSocket secure (WSS)", "443", "TCP", true, "Two-way browser connections over TLS"),
  p("Web and APIs", "gRPC", "443", "TCP", true, "Service-to-service calls over HTTP/2"),
  p("Web and APIs", "GraphQL", "443", "TCP", true, "Queries over HTTPS"),
  p("Web and APIs", "SOAP", "443", "TCP", true, "XML web services"),
  p("Web and APIs", "REST", "443", "TCP", true, "Resource APIs over HTTPS"),
  p("Web and APIs", "Server-sent events", "443", "TCP", true, "Server push to browsers"),
  // Remote access and administration
  p("Remote access", "SSH", "22", "TCP", true, "Secure shell and tunnels"),
  p("Remote access", "Telnet", "23", "TCP", false, "Legacy remote shell, clear text"),
  p("Remote access", "RDP", "3389", "TCP/UDP", true, "Windows Remote Desktop"),
  p("Remote access", "VNC", "5900", "TCP", false, "Remote screen sharing"),
  p("Remote access", "WinRM HTTP", "5985", "TCP", false, "Windows remote management"),
  p("Remote access", "WinRM HTTPS", "5986", "TCP", true, "Windows remote management over TLS"),
  p("Remote access", "Citrix ICA", "1494", "TCP", false, "Citrix virtual apps"),
  p("Remote access", "Citrix CGP", "2598", "TCP", false, "Citrix session reliability"),
  p("Remote access", "IPMI", "623", "UDP", false, "Out-of-band server management"),
  p("Remote access", "Redfish", "443", "TCP", true, "Out-of-band server management API"),
  // File transfer and sharing
  p("File transfer", "FTP", "21", "TCP", false, "File transfer, clear text"),
  p("File transfer", "FTP data", "20", "TCP", false, "FTP data channel"),
  p("File transfer", "FTPS", "990", "TCP", true, "FTP over TLS"),
  p("File transfer", "SFTP", "22", "TCP", true, "File transfer over SSH"),
  p("File transfer", "SCP", "22", "TCP", true, "File copy over SSH"),
  p("File transfer", "TFTP", "69", "UDP", false, "Boot images and device configs"),
  p("File transfer", "SMB", "445", "TCP", true, "Windows file shares (SMB 3 encrypts)"),
  p("File transfer", "NetBIOS session", "139", "TCP", false, "Legacy Windows sharing"),
  p("File transfer", "NFS", "2049", "TCP/UDP", false, "Unix file shares"),
  p("File transfer", "AS2", "443", "TCP", true, "B2B document exchange"),
  p("File transfer", "rsync", "873", "TCP", false, "File synchronisation"),
  // Email
  p("Email", "SMTP", "25", "TCP", false, "Mail between servers"),
  p("Email", "SMTP submission", "587", "TCP", true, "Mail from clients, STARTTLS"),
  p("Email", "SMTPS", "465", "TCP", true, "Mail submission over TLS"),
  p("Email", "IMAP", "143", "TCP", false, "Mailbox access"),
  p("Email", "IMAPS", "993", "TCP", true, "Mailbox access over TLS"),
  p("Email", "POP3", "110", "TCP", false, "Mail download"),
  p("Email", "POP3S", "995", "TCP", true, "Mail download over TLS"),
  p("Email", "Exchange Web Services", "443", "TCP", true, "Exchange and Outlook"),
  // Directory, identity and security
  p("Identity", "LDAP", "389", "TCP/UDP", false, "Directory queries"),
  p("Identity", "LDAPS", "636", "TCP", true, "Directory queries over TLS"),
  p("Identity", "Global catalog", "3268", "TCP", false, "Active Directory forest search"),
  p("Identity", "Global catalog over TLS", "3269", "TCP", true, "Active Directory forest search over TLS"),
  p("Identity", "Kerberos", "88", "TCP/UDP", true, "Windows and Unix sign-in"),
  p("Identity", "RADIUS authentication", "1812", "UDP", false, "Network and VPN sign-in"),
  p("Identity", "RADIUS accounting", "1813", "UDP", false, "Network session accounting"),
  p("Identity", "TACACS+", "49", "TCP", true, "Network device admin sign-in"),
  p("Identity", "SAML", "443", "TCP", true, "Single sign-on"),
  p("Identity", "OpenID Connect", "443", "TCP", true, "Single sign-on and OAuth"),
  p("Identity", "OCSP", "80", "TCP", false, "Certificate revocation checks"),
  p("Identity", "RPC endpoint mapper", "135", "TCP", false, "Windows RPC, AD replication"),
  // Name, time and addressing
  p("Name and time", "DNS", "53", "TCP/UDP", false, "Name resolution"),
  p("Name and time", "DNS over TLS", "853", "TCP", true, "Encrypted name resolution"),
  p("Name and time", "DNS over HTTPS", "443", "TCP", true, "Encrypted name resolution"),
  p("Name and time", "DHCP server", "67", "UDP", false, "Address assignment"),
  p("Name and time", "DHCP client", "68", "UDP", false, "Address assignment"),
  p("Name and time", "NTP", "123", "UDP", false, "Time synchronisation"),
  p("Name and time", "PTP", "319", "UDP", false, "Precision time"),
  p("Name and time", "mDNS", "5353", "UDP", false, "Local name discovery"),
  // Databases and caches
  p("Databases", "Microsoft SQL Server", "1433", "TCP", false, "SQL Server (encrypt on request)"),
  p("Databases", "Oracle Net (TNS)", "1521", "TCP", false, "Oracle Database listener"),
  p("Databases", "MySQL / MariaDB", "3306", "TCP", false, "MySQL and MariaDB"),
  p("Databases", "PostgreSQL", "5432", "TCP", false, "PostgreSQL (TLS on request)"),
  p("Databases", "MongoDB", "27017", "TCP", false, "MongoDB"),
  p("Databases", "Redis", "6379", "TCP", false, "Redis cache"),
  p("Databases", "Redis over TLS", "6380", "TCP", true, "Redis cache over TLS"),
  p("Databases", "Memcached", "11211", "TCP/UDP", false, "Memcached cache"),
  p("Databases", "Cassandra", "9042", "TCP", false, "Cassandra native protocol"),
  p("Databases", "Elasticsearch", "9200", "TCP", false, "Search and analytics REST"),
  p("Databases", "IBM Db2", "50000", "TCP", false, "Db2 database"),
  p("Databases", "SAP HANA", "30015", "TCP", false, "SAP HANA SQL"),
  p("Databases", "Neo4j Bolt", "7687", "TCP", false, "Graph database"),
  p("Databases", "ClickHouse", "9000", "TCP", false, "Analytics database"),
  // Messaging and streaming
  p("Messaging", "AMQP", "5672", "TCP", false, "RabbitMQ and message brokers"),
  p("Messaging", "AMQPS", "5671", "TCP", true, "AMQP over TLS"),
  p("Messaging", "Kafka", "9092", "TCP", false, "Event streaming"),
  p("Messaging", "Kafka over TLS", "9093", "TCP", true, "Event streaming over TLS"),
  p("Messaging", "MQTT", "1883", "TCP", false, "IoT messaging"),
  p("Messaging", "MQTT over TLS", "8883", "TCP", true, "IoT messaging over TLS"),
  p("Messaging", "IBM MQ", "1414", "TCP", false, "IBM MQ channels"),
  p("Messaging", "STOMP", "61613", "TCP", false, "Simple messaging"),
  p("Messaging", "NATS", "4222", "TCP", false, "Cloud-native messaging"),
  p("Messaging", "ZeroMQ", "5555", "TCP", false, "Brokerless messaging"),
  p("Messaging", "SIP", "5060", "TCP/UDP", false, "Voice and video call set-up"),
  p("Messaging", "SIP over TLS", "5061", "TCP", true, "Secure call set-up"),
  p("Messaging", "RTP / SRTP", "16384-32767", "UDP", true, "Voice and video media"),
  p("Messaging", "XMPP", "5222", "TCP", true, "Chat and presence"),
  p("Messaging", "SMPP", "2775", "TCP", false, "SMS between operators and gateways"),
  // Monitoring and management
  p("Monitoring", "SNMP", "161", "UDP", false, "Device monitoring (v3 can encrypt)"),
  p("Monitoring", "SNMP trap", "162", "UDP", false, "Device alerts"),
  p("Monitoring", "Syslog", "514", "UDP", false, "Logs"),
  p("Monitoring", "Syslog over TLS", "6514", "TCP", true, "Logs over TLS"),
  p("Monitoring", "NetFlow / IPFIX", "2055", "UDP", false, "Traffic flow records"),
  p("Monitoring", "Prometheus", "9090", "TCP", false, "Metrics scraping"),
  p("Monitoring", "Node exporter", "9100", "TCP", false, "Host metrics"),
  p("Monitoring", "Zabbix agent", "10050", "TCP", false, "Monitoring agent"),
  p("Monitoring", "Zabbix server", "10051", "TCP", false, "Monitoring server"),
  p("Monitoring", "OpenTelemetry (OTLP)", "4317", "TCP", false, "Traces, metrics and logs"),
  p("Monitoring", "ICMP (ping)", "", "IP", false, "Reachability"),
  // Networking, routing and tunnels
  p("Network and tunnels", "BGP", "179", "TCP", false, "Routing between networks"),
  p("Network and tunnels", "OSPF", "", "IP", false, "Routing inside a network"),
  p("Network and tunnels", "IPsec IKE", "500", "UDP", true, "VPN key exchange"),
  p("Network and tunnels", "IPsec NAT traversal", "4500", "UDP", true, "VPN through NAT"),
  p("Network and tunnels", "IPsec ESP", "", "IP", true, "VPN payload"),
  p("Network and tunnels", "OpenVPN", "1194", "UDP", true, "VPN"),
  p("Network and tunnels", "WireGuard", "51820", "UDP", true, "VPN"),
  p("Network and tunnels", "SSL VPN", "443", "TCP", true, "Remote access VPN"),
  p("Network and tunnels", "GRE", "", "IP", false, "Tunnels between routers"),
  p("Network and tunnels", "VXLAN", "4789", "UDP", false, "Overlay networks"),
  p("Network and tunnels", "L2TP", "1701", "UDP", false, "Layer 2 tunnels"),
  p("Network and tunnels", "PPTP (legacy)", "1723", "TCP", false, "Legacy VPN, weak"),
  // Storage
  p("Storage", "iSCSI", "3260", "TCP", false, "Block storage over IP"),
  p("Storage", "Fibre Channel", "", "Other", false, "SAN block storage"),
  p("Storage", "NVMe over TCP", "4420", "TCP", false, "Fast block storage over IP"),
  p("Storage", "S3 API", "443", "TCP", true, "Object storage"),
  p("Storage", "NDMP", "10000", "TCP", false, "Backup of storage arrays"),
  // Containers and cloud
  p("Containers and cloud", "Kubernetes API", "6443", "TCP", true, "Cluster control plane"),
  p("Containers and cloud", "Kubelet", "10250", "TCP", true, "Node agent"),
  p("Containers and cloud", "etcd", "2379", "TCP", true, "Cluster state store"),
  p("Containers and cloud", "Docker daemon over TLS", "2376", "TCP", true, "Container engine API"),
  p("Containers and cloud", "Container registry", "443", "TCP", true, "Image pulls and pushes"),
  p("Containers and cloud", "Consul", "8500", "TCP", false, "Service discovery"),
  p("Containers and cloud", "HashiCorp Vault", "8200", "TCP", true, "Secrets"),
  // Industrial and IoT
  p("Industrial and IoT", "Modbus TCP", "502", "TCP", false, "PLCs and meters"),
  p("Industrial and IoT", "DNP3", "20000", "TCP", false, "Utilities SCADA"),
  p("Industrial and IoT", "OPC UA", "4840", "TCP", true, "Industrial data exchange"),
  p("Industrial and IoT", "BACnet", "47808", "UDP", false, "Building automation"),
  p("Industrial and IoT", "EtherNet/IP", "44818", "TCP/UDP", false, "Industrial Ethernet"),
  p("Industrial and IoT", "PROFINET", "34964", "UDP", false, "Industrial Ethernet"),
  p("Industrial and IoT", "IEC 60870-5-104", "2404", "TCP", false, "Power grid SCADA"),
  p("Industrial and IoT", "CoAP", "5683", "UDP", false, "Constrained IoT devices"),
  // Finance and business
  p("Finance and business", "ISO 8583", "", "TCP", false, "Card payment messages"),
  p("Finance and business", "SWIFT FIN (MT)", "", "TCP", true, "Bank messages over SWIFTNet"),
  p("Finance and business", "ISO 20022", "443", "TCP", true, "Payment messages (MX)"),
  p("Finance and business", "FIX", "9876", "TCP", false, "Trading"),
  p("Finance and business", "EDI over AS2", "443", "TCP", true, "Business documents"),
  p("Finance and business", "HL7 MLLP", "2575", "TCP", false, "Health records exchange"),
  p("Finance and business", "FHIR", "443", "TCP", true, "Health data APIs"),
  p("Finance and business", "DICOM", "104", "TCP", false, "Medical images"),
  // Printing and other
  p("Printing and other", "IPP", "631", "TCP", false, "Printing"),
  p("Printing and other", "LPD", "515", "TCP", false, "Legacy printing"),
  p("Printing and other", "Raw printing (JetDirect)", "9100", "TCP", false, "Printing"),
  p("Printing and other", "NetBIOS name service", "137", "UDP", false, "Legacy Windows names"),
];

/** The protocols with the workspace's own changes on top; applyProtocolItems sets it. */
export let PROTOCOLS: ProtocolInfo[] = [...BUILT_IN_PROTOCOLS];
export let PROTOCOL_GROUPS = [...new Set(PROTOCOLS.map((x) => x.group))];
const BUILT_IN_PROTOCOL_IDS = new Set(BUILT_IN_PROTOCOLS.map((x) => x.id));
export const isBuiltInProtocol = (id: string) => BUILT_IN_PROTOCOL_IDS.has(id);
export const builtInProtocol = (id: string) => BUILT_IN_PROTOCOLS.find((x) => x.id === id);

let applied = "";
/** Puts a workspace's own protocols on top of the built-in ones, the same way as its components. */
export function applyProtocolItems(items: Record<string, LibraryItem> | undefined): boolean {
  const own = Object.values(items ?? {}).filter((i) => i.type === "protocol");
  const key = own.map((i) => `${i.id}:${i.updatedAt}:${i.removed ? 1 : 0}`).sort().join("|");
  if (key === applied) return false;
  applied = key;
  const removed = new Set(own.filter((i) => i.removed).map((i) => i.id));
  const changed = new Map<string, ProtocolInfo>();
  for (const i of own) {
    if (i.removed || !i.protocol) continue;
    changed.set(i.id, { id: i.id, ...i.protocol, port: i.protocol.port ?? "", use: i.protocol.use ?? "", ...(BUILT_IN_PROTOCOL_IDS.has(i.id) ? { changed: true } : { custom: true }) });
  }
  const next = BUILT_IN_PROTOCOLS.filter((x) => !removed.has(x.id)).map((x) => changed.get(x.id) ?? x);
  for (const x of changed.values()) if (x.custom) next.push(x);
  PROTOCOLS = next;
  PROTOCOL_GROUPS = [...new Set(PROTOCOLS.map((x) => x.group))];
  return true;
}

/** "HTTPS 443/TCP", as a protocol is written on a line. */
export const protocolLabel = (x: { name: string; port?: string; transport?: string }) => [x.name, x.port ? `${x.port}${x.transport && x.transport !== "Other" && x.transport !== "IP" ? `/${x.transport}` : ""}` : ""].filter(Boolean).join(" ");

/** The catalogue entry a protocol name stands for, if any. */
export function protocolByName(name: string): ProtocolInfo | undefined {
  const key = name.trim().toLowerCase();
  return PROTOCOLS.find((x) => x.name.toLowerCase() === key);
}

/** Protocols whose name, port, group or use contain every word typed. */
export function searchProtocols(query: string): ProtocolInfo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return PROTOCOLS;
  return PROTOCOLS.filter((x) => {
    const hay = `${x.name} ${x.port} ${x.transport} ${x.group} ${x.use}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
