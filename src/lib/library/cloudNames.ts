/**
 * Names of cloud services, grouped by each provider's own sections.
 *
 * AWS, Microsoft Azure, Google Cloud and IBM Cloud start from the names in
 * draw.io's shape libraries (github.com/jgraph/drawio, Apache License 2.0), cleaned of
 * duplicates, retired products and icons that are not services; Google Cloud names were
 * brought up to date. Oracle Cloud Infrastructure and Huawei Cloud are not in draw.io, and its Alibaba Cloud list
 * is out of date, so these three were listed by hand from the providers' product names. Names only: no provider artwork.
 * Generated once on 2026-11-16; edit by hand from here on.
 */

export const CLOUD_NAMES: Record<string, [section: string, names: string[]][]> = {
 "aws": [
  [
   "Analytics",
   [
    "Athena",
    "DataZone",
    "CloudSearch",
    "OpenSearch Service",
    "EMR",
    "FinSpace",
    "Kinesis",
    "Data Firehose",
    "Kinesis Data Streams",
    "Kinesis Video Streams",
    "Managed Service for Apache Flink",
    "Clean Rooms",
    "Redshift",
    "SageMaker",
    "Entity Resolution",
    "Managed Streaming for Apache Kafka",
    "Glue",
    "Glue DataBrew",
    "Lake Formation",
    "Data Exchange"
   ]
  ],
  [
   "Application Integration",
   [
    "API Gateway",
    "MQ",
    "Simple Notification Service",
    "Simple Queue Service",
    "AppSync",
    "B2B Data Interchange",
    "EventBridge",
    "Managed Workflows for Apache Airflow",
    "Step Functions",
    "AppFlow"
   ]
  ],
  [
   "Cloud Financial Management",
   [
    "Budgets",
    "Cost & Usage Report",
    "Cost Explorer",
    "FinOps Agent",
    "Billing Conductor",
    "Reserved Instance Reporting",
    "Savings Plans"
   ]
  ],
  [
   "Blockchain",
   [
    "Managed Blockchain"
   ]
  ],
  [
   "Business Applications",
   [
    "Chime",
    "Connect",
    "Chime Voice Connector",
    "Pinpoint",
    "Quick",
    "Simple Email Service",
    "WorkMail",
    "AppFabric",
    "End User Messaging",
    "Supply Chain",
    "Wickr"
   ]
  ],
  [
   "Compute",
   [
    "EC2",
    "EC2 Auto Scaling",
    "Auto Scaling",
    "Bottlerocket",
    "Lightsail",
    "App Runner",
    "Batch",
    "Compute Optimizer",
    "Elastic Beanstalk",
    "Elastic Fabric Adapter",
    "Fargate",
    "EC2 Image Builder",
    "Elastic VMware Service",
    "Lambda",
    "Local Zones",
    "DCV",
    "Nitro Enclaves",
    "Outposts rack",
    "Outposts servers",
    "Parallel Cluster",
    "Parallel Computing Service",
    "Serverless Application Repository",
    "SimSpace Weaver",
    "Elastic Load Balancing",
    "Wavelength"
   ]
  ],
  [
   "Containers",
   [
    "ECS Anywhere",
    "EKS Anywhere",
    "EKS Distro",
    "Elastic Kubernetes Service",
    "Elastic Container Registry",
    "Elastic Container Service",
    "Red Hat OpenShift Service on AWS"
   ]
  ],
  [
   "Databases",
   [
    "Aurora",
    "DocumentDB",
    "DynamoDB",
    "ElastiCache",
    "Managed Apache Cassandra Service",
    "Neptune",
    "RDS",
    "Timestream",
    "Database Migration Service",
    "Oracle Database at AWS",
    "Keyspaces",
    "MemoryDB"
   ]
  ],
  [
   "Developer Tools",
   [
    "CodeCatalyst",
    "Cloud Control API",
    "Cloud Development Kit",
    "CloudShell",
    "CodeArtifact",
    "CodeBuild",
    "CodeDeploy",
    "CodePipeline",
    "Fault Injection Service",
    "Corretto",
    "Infrastructure Composer",
    "X-Ray"
   ]
  ],
  [
   "End User Computing",
   [
    "WorkSpaces",
    "WorkSpaces Thin Client"
   ]
  ],
  [
   "Front End Web Mobile",
   [
    "Amplify",
    "Device Farm",
    "Location Service"
   ]
  ],
  [
   "Games",
   [
    "GameLift Servers",
    "GameLift Streams",
    "Open 3D Engine"
   ]
  ],
  [
   "Internet of Things",
   [
    "FreeRTOS",
    "Core",
    "Device Defender",
    "Device Management",
    "Events",
    "ExpressLink",
    "FleetWise",
    "IoT Greengrass",
    "SiteWise",
    "TwinMaker"
   ]
  ],
  [
   "Artificial Intelligence",
   [
    "Augmented AI (A2I)",
    "Bedrock",
    "Bedrock AgentCore",
    "CodeGuru",
    "Comprehend",
    "Comprehend Medical",
    "DevOps Guru",
    "Forecast",
    "Fraud Detector",
    "HealthLake",
    "Kendra",
    "Neuron",
    "Panorama",
    "Lex",
    "Lookout for Equipment",
    "Lookout for Vision",
    "Monitron",
    "Nova",
    "HealthOmics",
    "HealthScribe",
    "Personalize",
    "Polly",
    "Q",
    "Rekognition",
    "SageMaker AI",
    "SageMaker Ground Truth",
    "SageMaker Studio Lab",
    "Textract",
    "Transcribe",
    "Translate",
    "App Studio",
    "Deep Learning AMIs",
    "HealthImaging",
    "TensorFlow on AWS",
    "PyTorch on AWS",
    "Deep Learning Containers",
    "Elemental Inference"
   ]
  ],
  [
   "Management Tools",
   [
    "CloudWatch",
    "Managed Grafana",
    "Managed Service for Prometheus",
    "App Config",
    "Launch Wizard",
    "Application Auto Scaling",
    "Backint Agent",
    "Chatbot",
    "CloudFormation",
    "CloudTrail",
    "Config",
    "Control Tower",
    "DevOps Agent",
    "Distro for OpenTelemetry",
    "License Manager",
    "Managed Services",
    "Organizations",
    "Health Dashboard",
    "Proton",
    "Resilience Hub",
    "Resource Explorer",
    "Service Catalog",
    "Service Management Connector",
    "Systems Manager",
    "Telco Network Builder",
    "Systems Manager - Incident Manager",
    "Trusted Advisor",
    "User Notifications",
    "Well-Architected Tool",
    "Sustainability"
   ]
  ],
  [
   "Media Services",
   [
    "Deadline Cloud",
    "Elemental Appliances & Software",
    "Elemental MediaConnect",
    "Elemental MediaConvert",
    "Elemental MediaLive",
    "Elemental MediaPackage",
    "Elemental MediaStore",
    "Elemental MediaTailor",
    "Elemental Live",
    "Interactive Video Service",
    "Elemental Link"
   ]
  ],
  [
   "Migration & Modernization",
   [
    "Application Discovery Service",
    "DataSync",
    "Data Transfer Terminal",
    "Mainframe Modernization",
    "Migration Evaluator",
    "Snowball",
    "Snowball Edge",
    "Application Migration Service",
    "Transfer Family",
    "Transform"
   ]
  ],
  [
   "Network & Content Delivery",
   [
    "Application Recovery Controller",
    "Cloud Directory",
    "CloudFront",
    "Route 53",
    "PrivateLink",
    "VPC",
    "VPC Lattice",
    "App Mesh",
    "Client VPN",
    "Site-to-Site VPN",
    "Cloud Map",
    "Cloud WAN",
    "Direct Connect",
    "Global Accelerator",
    "RTB Fabric",
    "Transit Gateway",
    "Verified Access",
    "Interconnect"
   ]
  ],
  [
   "Quantum Technologies",
   [
    "Braket"
   ]
  ],
  [
   "Satellite",
   [
    "Ground Station"
   ]
  ],
  [
   "Security & Identity",
   [
    "Cognito",
    "Detective",
    "GuardDuty",
    "Inspector",
    "Macie",
    "Security Lake",
    "Verified Permissions",
    "Artifact",
    "Audit Manager",
    "Certificate Manager",
    "CloudHSM",
    "Directory Service",
    "Firewall Manager",
    "Identity & Access Management",
    "Key Management Service",
    "Network Firewall",
    "Payment Cryptography",
    "Private Certificate Authority",
    "Resource Access Manager",
    "Secrets Manager",
    "Security Agent",
    "Security Hub",
    "Security Incident Response",
    "Shield",
    "Signer",
    "IAM Identity Center",
    "WAF"
   ]
  ],
  [
   "Storage",
   [
    "Elastic Block Store",
    "File Cache",
    "Elastic File System",
    "FSx",
    "FSx for Lustre",
    "FSx for NetApp ONTAP",
    "FSx for OpenZFS",
    "FSx for Windows File Server",
    "S3 on Outposts",
    "S3 Glacier",
    "Simple Storage Service (S3)",
    "Backup",
    "Storage Gateway",
    "Elastic Disaster Recovery"
   ]
  ]
 ],
 "azure": [
  [
   "AI and Machine Learning",
   [
    "AI Foundry",
    "AI Foundry IQ",
    "AI Studio",
    "Anomaly Detector",
    "Applied AI",
    "Azure Machine Learning",
    "Batch AI",
    "Bonsai",
    "Bot Services",
    "Computer Vision",
    "Cognitive Search",
    "Cognitive Services",
    "Content Moderators",
    "Custom Vision",
    "Experimentation Studio",
    "Face APIs",
    "Form Recognizers",
    "Foundry Agent Service",
    "Foundry Application",
    "Foundry Control Plane",
    "Foundry Labs",
    "Foundry Local",
    "Foundry Models",
    "Foundry Project",
    "FRD QA",
    "Genomics",
    "Immersive Readers",
    "Language",
    "Cognitive Services Decisions",
    "Content Safety",
    "Language Understanding",
    "Machine Learning",
    "Machine Learning Studio - Classic Web Services",
    "Machine Learning Studio - Web Service Plans",
    "Machine Learning Studio - Workspaces",
    "Metrics Advisor",
    "Object Understanding",
    "OpenAI",
    "Personalizers",
    "Planetary Computer Pro",
    "QnA Makers",
    "Serverless Search",
    "Speech Services",
    "Translator Text"
   ]
  ],
  [
   "Analytics",
   [
    "Analysis Services",
    "Data Explorer Clusters",
    "Data Factories",
    "Data Lake Analytics",
    "Data Lake Store Gen1",
    "Databricks",
    "Endpoint Analytics",
    "Event Hub Clusters",
    "Event Hubs",
    "HD Insight Clusters",
    "Log Analytics Workspaces",
    "Power BI Embedded",
    "Power Platform",
    "Private Link Services",
    "Stream Analytics Jobs",
    "Synapse Analytics",
    "Workbooks"
   ]
  ],
  [
   "App Services",
   [
    "API Management Services",
    "App Service Certificates",
    "App Service Domains",
    "App Service Environments",
    "App Service Plans",
    "App Services",
    "CDN Profiles",
    "Notification Hubs",
    "Search Services"
   ]
  ],
  [
   "Azure Stack",
   [
    "Capacity",
    "Infrastructure Backup",
    "Multi Tenancy",
    "Offers",
    "Plans",
    "Stack",
    "Updates",
    "User Subscriptions"
   ]
  ],
  [
   "VMware Solution",
   [
    "AVS"
   ]
  ],
  [
   "Blockchain",
   [
    "ABS Member",
    "Blockchain Applications",
    "Blockchain Service",
    "Consortium",
    "Outbound Connection",
    "Token Service"
   ]
  ],
  [
   "Compute",
   [
    "Application Group",
    "Automanaged VM",
    "Availability Sets",
    "Azure Linux",
    "Batch Accounts",
    "Cloud Services (Classic)",
    "Compute Galleries",
    "Container Instances",
    "Container Services (deprecated)",
    "Disk Encryption Sets",
    "Disks",
    "Disks Snapshots",
    "Function Apps",
    "Host Groups",
    "Host Pools",
    "Hosts",
    "Image Definitions",
    "Image Templates",
    "Image Versions",
    "Images",
    "Kubernetes Services",
    "Maintenance Configuration",
    "Managed Service Fabric",
    "Mesh Applications",
    "OS Images (Classic)",
    "Restore Points",
    "Restore Points Collections",
    "Scheduled Actions",
    "Service Fabric Clusters",
    "Shared Image Galleries",
    "Spring Cloud",
    "Stage Maps",
    "Virtual Machine",
    "Virtual Machines (Classic)",
    "VM Images (Classic)",
    "VM Scale Sets",
    "Workspaces"
   ]
  ],
  [
   "Containers",
   [
    "AKS Network Policy",
    "Container Registries",
    "Container Storage",
    "Kubernetes Hub",
    "Red Hat OpenShift",
    "Service Groups"
   ]
  ],
  [
   "Databases",
   [
    "Azure DocumentDB",
    "Azure Managed Redis",
    "Cache Redis",
    "Cosmos DB",
    "Data Factory",
    "Database MariaDB Server",
    "Database Migration Services",
    "Database MySQL Server",
    "Database PostgreSQL Server",
    "Database PostgreSQL Server Group",
    "Elastic Job Agents",
    "Instance Pools",
    "Managed Database",
    "Oracle Database",
    "Purview Accounts",
    "SQL",
    "SQL Data Warehouses",
    "SQL Database",
    "SQL Database Fleet Manager",
    "SQL Edge",
    "SQL Elastic Pools",
    "SQL Managed Instance",
    "SQL Server",
    "SQL Server Registries",
    "SQL Server Stretch Databases",
    "SQL VM",
    "SSIS Lift and Shift IR",
    "Virtual Clusters"
   ]
  ],
  [
   "DevOps",
   [
    "API Connections",
    "Application Insights",
    "Azure App Testing",
    "Change Analysis",
    "CloudTest",
    "Code Optimization",
    "DevOps",
    "DevOps Starter",
    "DevTest Labs",
    "Lab Accounts",
    "Lab Services",
    "Load Testing"
   ]
  ],
  [
   "Hybrid and Multicloud",
   [
    "AI at Edge",
    "Azure Local",
    "Azure Operator 5G Core",
    "Azure Operator Insights",
    "Azure Operator Nexus",
    "Azure Operator Service Manager",
    "Azure Programmable Connectivity",
    "Edge Storage Accelerator",
    "Workload Orchestration"
   ]
  ],
  [
   "Identity",
   [
    "AAD Licenses",
    "Active Directory",
    "Active Directory Connect Health",
    "AD B2C",
    "AD Domain Services",
    "AD Identity Protection",
    "AD Privilege Identity Management",
    "AD Roles and Administrators",
    "Administrative Units",
    "API Proxy",
    "App Registrations",
    "Azure AD B2C",
    "Custom Azure AD Roles",
    "Enterprise Applications",
    "Entra Connect",
    "Entra Domain Services",
    "Entra Global Secure Access",
    "Entra ID Protection",
    "Entra Internet Access",
    "Entra Managed Identities",
    "Entra Private Access",
    "Entra Privileged Identity Management",
    "Entra Verified ID",
    "External ID",
    "External Identities",
    "Groups",
    "Identity Governance",
    "Information Protection",
    "Managed Identities",
    "Multi-Factor Authentication",
    "PIM",
    "Security",
    "Tenant Properties",
    "User Settings",
    "Users",
    "Verifiable Credentials",
    "Verification As A Service",
    "Intune"
   ]
  ],
  [
   "Integration",
   [
    "AI Gateway",
    "API for FHIR",
    "App Configuration",
    "Data Catalog",
    "Databox Gateway",
    "Event Grid Domains",
    "Event Grid Subscriptions",
    "Event Grid Topics",
    "Integration Accounts",
    "Integration Environments",
    "Integration Service Environments",
    "Logic Apps",
    "Logic Apps Custom Connector",
    "Logic Apps Template",
    "Partner Namespace",
    "Partner Registration",
    "Partner Topic",
    "PubSub",
    "Relays",
    "SendGrid Accounts",
    "Service Bus",
    "Software as a Service",
    "Stack Edge",
    "StorSimple Device Managers",
    "System Topic"
   ]
  ],
  [
   "IoT",
   [
    "Device Provisioning Services",
    "Digital Twins",
    "Hybrid Connectivity Hub",
    "Industrial IoT",
    "IoT Central Applications",
    "IoT Edge",
    "IoT Hub",
    "IoT Operations",
    "Maps Accounts",
    "Stack HCI Sizer",
    "Stack HCI Premium",
    "Time Series Data Sets",
    "Time Series Insights Access Policies",
    "Time Series Insights Environments",
    "Time Series Insights Event Sources",
    "Windows10 Core Services"
   ]
  ],
  [
   "Management and Governance",
   [
    "Activity Log",
    "Advisor",
    "Alerts",
    "Arc",
    "Arc Machines",
    "Automation Accounts",
    "Blueprints",
    "Compliance",
    "Cost Management and Billing",
    "Customer Lockbox for MS Azure",
    "Diagnostics Settings",
    "Education",
    "Landing Zone",
    "Lighthouse",
    "MachinesAzureArc",
    "Managed Applications Center",
    "Managed Desktop",
    "Metrics",
    "Monitor",
    "My Customers",
    "Operation Log (Classic)",
    "Policy",
    "Recovery Services Vaults",
    "Resource Graph Explorer",
    "Resources Provider",
    "Scheduler Job Collections",
    "Service Catalog MAD",
    "Service Group Relationships",
    "Service Providers",
    "Solutions",
    "Universal Print",
    "User Privacy"
   ]
  ],
  [
   "Migrate",
   [
    "Data Box",
    "Data Box Edge",
    "Migrate"
   ]
  ],
  [
   "Mixed Reality",
   [
    "Remote Rendering",
    "Spatial Anchor Accounts"
   ]
  ],
  [
   "Monitor",
   [
    "Network Watcher",
    "SAP Azure Monitor",
    "Scale"
   ]
  ],
  [
   "Networking",
   [
    "Access Point",
    "Application Gateway Containers",
    "Application Gateways",
    "ATM Multistack",
    "Bastions",
    "Communications Gateway",
    "Connected Cache",
    "Connections",
    "DDoS Custom Policy",
    "DDoS Protection Plans",
    "DNS Multistack",
    "DNS Private Resolver",
    "DNS Security Policy",
    "DNS Zones",
    "Edge Actions",
    "ExpressRoute Circuits",
    "Firewall Manager",
    "Firewall Policy",
    "Firewalls",
    "Front Doors",
    "IP Address Manager",
    "IP Groups",
    "Load Balancer Hub",
    "Load Balancers",
    "Local Network Gateways",
    "NAT",
    "Network Foundation Hub",
    "Network Interfaces",
    "Network Security Groups",
    "Network Security Hub",
    "On Premises Data Gateways",
    "Private Endpoint",
    "Private Link",
    "Private Link Hub",
    "Private Link Service",
    "Proximity Placement Groups",
    "Public IP Addresses",
    "Public IP Addresses (Classic)",
    "Public IP Prefixes",
    "Reserved IP Addresses (Classic)",
    "Resource Management Private Link",
    "Route Filters",
    "Route Tables",
    "Service Endpoint Policies",
    "Spot VM",
    "Spot VMSS",
    "Subnet",
    "Traffic Manager Profiles",
    "Virtual Network Gateways",
    "Virtual Networks",
    "Virtual Networks (Classic)",
    "Virtual Router",
    "Virtual WAN Hub",
    "Virtual WANs",
    "VNet Appliance",
    "VPN Client Windows",
    "Web Application Firewall Policies (WAF)"
   ]
  ],
  [
   "More services",
   [
    "ACS Solutions Builder",
    "AKS Automatic",
    "AKS Istio",
    "App Compliance Automation",
    "Arc Data Services",
    "Arc Kubernetes",
    "Arc PostgreSQL",
    "Arc SQL Managed Instance",
    "Arc SQL Server",
    "AVS VM",
    "Azure Enclaves",
    "Azurite",
    "Backup Center",
    "Backup Vault",
    "Bare Metal Infrastructure",
    "Business Process Tracking",
    "Center for SAP",
    "Central Service Instance for SAP",
    "Chaos Studio",
    "Cloud Services (extended support)",
    "Cloud Shell",
    "Communication Services",
    "Compliance Center",
    "Compute Fleet",
    "Container App Environments",
    "Connected Vehicle Platform",
    "Cost Export",
    "Custom IP Prefix",
    "Dashboard Hub",
    "Data Collection Rules",
    "Data Sharing",
    "Data Transfer",
    "Database Instance for SAP",
    "Dedicated HSM",
    "Defender CM Local Manager",
    "Defender DCS Controller",
    "Defender External Management",
    "Deployment Environments",
    "Detonation",
    "Device Update IoT Hub",
    "Dev Tunnels",
    "Disconnected Operations",
    "Disk Pool",
    "Edge Hardware Center",
    "Edge Management",
    "Elastic SAN",
    "Entra Connect Health",
    "Entra Connect Sync",
    "Entra Identity",
    "Exchange On Premises Access",
    "Express Route Traffic Collector",
    "ExpressRoute Direct",
    "FHIR Service",
    "Grafana",
    "HDI AKS Cluster",
    "HPC Workbench",
    "Image Definition",
    "Image Version",
    "Internet Analyzer Profiles",
    "Kubernetes Fleet Manager",
    "Log Analytics Query Pack",
    "Managed DevOps Pools",
    "Managed File Shares",
    "Managed Instance Apache Cassandra",
    "MedTech Service",
    "Microsoft Discovery",
    "Mission Landing Zone",
    "Modular Data Center",
    "Monitor Dashboard",
    "Monitor Health Models",
    "Monitor Pipeline",
    "MS Dev Box",
    "Network Function Manager",
    "Network Function Manager Functions",
    "Network Manager",
    "Network Security Perimeters",
    "Open Supply Chain Platform",
    "Orbital",
    "OSConfig",
    "Peering Service",
    "Peerings",
    "Private Endpoints",
    "Private Mobile Network",
    "Prometheus",
    "Reserved Capacity",
    "Resiliency",
    "Resource Guard",
    "Resource Mover",
    "RTOS",
    "Savings Plan",
    "SCVMM Management Servers",
    "Sphere",
    "SSH Keys",
    "Storage Actions",
    "Storage Mover",
    "Storage Tasks",
    "Support Sustainability",
    "Template Specs",
    "Test Base",
    "Update Center",
    "Video Analyzers",
    "Video Indexer",
    "Virtual Enclaves",
    "Virtual Instance for SAP",
    "VM Application Definition",
    "VM Application Version",
    "VMWare Solution",
    "WAC",
    "Web App Database",
    "Web Jobs",
    "Windows Notification Services",
    "Windows Virtual Desktop",
    "Worker Container App",
    "Workspace Gateway",
    "Attestation",
    "Confidential Ledger"
   ]
  ],
  [
   "Power Platform",
   [
    "AI Builder",
    "Copilot Studio",
    "Dataverse",
    "PowerApps",
    "PowerAutomate",
    "PowerBI",
    "PowerFx",
    "PowerPages"
   ]
  ],
  [
   "Security",
   [
    "AD Authentication Methods",
    "AD Privileged Identity Management",
    "AD Risky Signins",
    "AD Risky Users",
    "Application Security Groups",
    "Conditional Access",
    "Defender",
    "Extended Security Updates",
    "Identity Secure Score",
    "Key Vaults",
    "Keys",
    "MS Defender EASM",
    "Security Center",
    "Sentinel"
   ]
  ],
  [
   "Storage",
   [
    "Data Lake Storage Gen1",
    "Data Share Invitations",
    "Data Shares",
    "Data Virtualization",
    "Fileshare",
    "HCP Cache",
    "Import Export Jobs",
    "NetApp Files",
    "Storage Accounts",
    "Storage Accounts (Classic)",
    "Storage Explorer",
    "Storage Hubs",
    "Storage Sync Services",
    "StorSimple Data Managers"
   ]
  ],
  [
   "Web",
   [
    "Agentic Web Apps",
    "API Center",
    "App Space",
    "Front Door and CDN Profiles",
    "Media Service",
    "Notification Hub Namespaces",
    "SignalR",
    "Spring Apps",
    "Static Apps"
   ]
  ]
 ],
 "gcp": [
  [
   "AI and Machine Learning",
   [
    "AutoML",
    "Cloud Natural Language API",
    "Cloud TPU",
    "Cloud Translation API",
    "Cloud Vision API",
    "Data Labeling",
    "Dialogflow",
    "Recommendations AI",
    "Speech to Text",
    "Text to Speech",
    "Video Intelligence API",
    "Vertex AI",
    "Gemini",
    "Vertex AI Search",
    "Vertex AI Agent Builder",
    "Document AI",
    "Contact Center AI",
    "Gemini Code Assist"
   ]
  ],
  [
   "API Management",
   [
    "API Analytics",
    "Apigee API Platform",
    "API Monetization",
    "Cloud Endpoints",
    "Developer Portal"
   ]
  ],
  [
   "Compute",
   [
    "App Engine",
    "Cloud Functions",
    "Cloud Run",
    "Cloud GPU",
    "Compute Engine",
    "Container Optimized OS",
    "GKE Enterprise (on-premises)",
    "Google Kubernetes Engine (GKE)",
    "Batch",
    "Bare Metal Solution",
    "Google Cloud VMware Engine",
    "Cloud Workstations",
    "Sole-tenant nodes",
    "Spot VMs"
   ]
  ],
  [
   "Data Analytics",
   [
    "BigQuery",
    "Cloud Composer",
    "Cloud Data Fusion",
    "Data Catalog",
    "Datalab",
    "Looker Studio",
    "Dataflow",
    "Dataprep",
    "Dataproc",
    "Pub/Sub",
    "Looker",
    "Dataplex",
    "Datastream",
    "BigLake",
    "Managed Service for Apache Kafka"
   ]
  ],
  [
   "Databases",
   [
    "Bigtable",
    "Spanner",
    "Cloud SQL",
    "Datastore",
    "Firestore",
    "Memorystore",
    "AlloyDB",
    "Database Migration Service",
    "Firebase Realtime Database"
   ]
  ],
  [
   "Developer Tools",
   [
    "Artifact Registry",
    "Cloud Build",
    "Cloud Scheduler",
    "Cloud Tasks",
    "Cloud Deployment Manager",
    "Cloud Deploy",
    "Firebase",
    "Eventarc",
    "Workflows",
    "Application Integration"
   ]
  ],
  [
   "Migration",
   [
    "Transfer Appliance"
   ]
  ],
  [
   "Security",
   [
    "Identity and Access Management (IAM)",
    "Cloud Resource Manager",
    "Cloud Security Scanner",
    "Key Management Service",
    "Security Command Center",
    "BeyondCorp",
    "Sensitive Data Protection",
    "Key Access Justifications",
    "Secret Manager",
    "Certificate Authority Service",
    "Certificate Manager",
    "Identity Platform",
    "Google Security Operations",
    "reCAPTCHA",
    "Cloud IDS",
    "Identity-Aware Proxy",
    "Assured Workloads",
    "Binary Authorization",
    "VPC Service Controls"
   ]
  ],
  [
   "Operations",
   [
    "Anthos Service Mesh",
    "Cloud Logging",
    "Cloud Monitoring",
    "Error Reporting",
    "Profiler",
    "Trace",
    "Cloud Trace",
    "Managed Service for Prometheus",
    "Cloud Profiler"
   ]
  ],
  [
   "Networking",
   [
    "Cloud CDN",
    "Cloud DNS",
    "Cloud External IP Addresses",
    "Cloud Firewall Rules",
    "Cloud Interconnect",
    "Cloud Load Balancing",
    "Cloud NAT",
    "Cloud Router",
    "Cloud VPN",
    "Cloud Armor",
    "Partner Interconnect",
    "Traffic Director",
    "Virtual Private Cloud",
    "Network Connectivity Center",
    "Private Service Connect",
    "Cloud Next Generation Firewall",
    "Cloud Service Mesh",
    "Network Intelligence Center",
    "Cloud Domains"
   ]
  ],
  [
   "Storage",
   [
    "Cloud Storage",
    "Filestore",
    "Persistent Disk",
    "Backup and DR",
    "Storage Transfer Service",
    "Hyperdisk"
   ]
  ]
 ],
 "ibm": [
  [
   "AI",
   [
    "watsonx.ai",
    "watsonx.data",
    "watsonx.governance",
    "watsonx Orchestrate",
    "watsonx Assistant",
    "watsonx Code Assistant",
    "watsonx Z Code Assistant",
    "watsonx Z Refactor Code Assistant",
    "Watson Discovery",
    "Watson Machine Learning",
    "Watson Studio"
   ]
  ],
  [
   "Compute",
   [
    "Virtual Server",
    "Power Virtual Server",
    "Classic Virtual Server",
    "Bare Metal Server",
    "Classic Bare Metal Server",
    "Dedicated Host",
    "Image Service",
    "IBM Cloud Satellite",
    "Code Engine",
    "Hyper Protect Virtual Servers",
    "VMware Solutions"
   ]
  ],
  [
   "Containers",
   [
    "Red Hat OpenShift on IBM Cloud",
    "IBM Cloud Kubernetes Service",
    "Z Containers",
    "Container Registry"
   ]
  ],
  [
   "Data",
   [
    "Db2",
    "Db2 Warehouse",
    "Cloudant",
    "Databases for DataStax",
    "Databases for Elasticsearch",
    "Databases for EnterpriseDB",
    "Databases for etcd",
    "Databases for MongoDB",
    "Databases for MySQL",
    "Databases for PostgreSQL",
    "Databases for Redis",
    "Event Streams",
    "Cloud Pak for Data",
    "Messages for RabbitMQ"
   ]
  ],
  [
   "DevOps",
   [
    "Continuous Delivery",
    "Continuous Integration",
    "Source Code Repository",
    "Toolchain",
    "MQ on Cloud",
    "Ansible",
    "GitLab",
    "Cloud Pak for Integration"
   ]
  ],
  [
   "Network",
   [
    "Load Balancer",
    "Application Load Balancer",
    "Network Load Balancer",
    "Global Load Balancer",
    "Classic Load Balancer",
    "Floating IP",
    "Endpoint Gateway",
    "Public Gateway",
    "Transit Gateway",
    "Direct Link Connect",
    "Direct Link Dedicated",
    "DNS Services",
    "Internet Services"
   ]
  ],
  [
   "Observability",
   [
    "Cloud Logs",
    "Flow Logs",
    "Monitoring",
    "Activity Tracker Event Routing",
    "Event Notifications"
   ]
  ],
  [
   "Security",
   [
    "App ID",
    "Key Protect",
    "Secrets Manager",
    "Security Compliance Center",
    "VPN Gateway",
    "VPN Connection",
    "Bastion Host",
    "Cloud Pak for Security",
    "Hyper Protect Crypto Services",
    "Security and Compliance Center Workload Protection",
    "Certificate Manager"
   ]
  ],
  [
   "Storage",
   [
    "Block Storage",
    "Object Storage",
    "File Storage",
    "Backup and Recovery"
   ]
  ]
 ],
 "alibaba": [
  [
   "Compute",
   [
    "Elastic Compute Service (ECS)",
    "ECS Bare Metal Instance",
    "Elastic GPU Service",
    "Simple Application Server",
    "Auto Scaling",
    "Elastic High Performance Computing (E-HPC)",
    "Dedicated Host"
   ]
  ],
  [
   "Containers and Serverless",
   [
    "Container Service for Kubernetes (ACK)",
    "Container Registry (ACR)",
    "Elastic Container Instance (ECI)",
    "Service Mesh (ASM)",
    "Function Compute",
    "Serverless App Engine (SAE)",
    "CloudFlow"
   ]
  ],
  [
   "Storage",
   [
    "Object Storage Service (OSS)",
    "File Storage NAS",
    "Elastic Block Storage (EBS)",
    "Cloud Parallel File Storage (CPFS)",
    "Cloud Backup",
    "Hybrid Backup Recovery (HBR)",
    "Data Online Migration",
    "Data Transport"
   ]
  ],
  [
   "Databases",
   [
    "ApsaraDB RDS for MySQL",
    "ApsaraDB RDS for PostgreSQL",
    "ApsaraDB RDS for SQL Server",
    "ApsaraDB RDS for MariaDB",
    "PolarDB",
    "PolarDB-X",
    "Tair (Redis compatible)",
    "ApsaraDB for MongoDB",
    "Lindorm",
    "Tablestore",
    "ApsaraDB for ClickHouse",
    "AnalyticDB for MySQL",
    "AnalyticDB for PostgreSQL",
    "Graph Database",
    "OceanBase",
    "Data Transmission Service (DTS)",
    "Database Backup (DBS)",
    "Data Management (DMS)",
    "Database Autonomy Service (DAS)"
   ]
  ],
  [
   "Networking",
   [
    "Virtual Private Cloud (VPC)",
    "Classic Load Balancer (CLB)",
    "Application Load Balancer (ALB)",
    "Network Load Balancer (NLB)",
    "NAT Gateway",
    "Elastic IP Address (EIP)",
    "Express Connect",
    "VPN Gateway",
    "Cloud Enterprise Network (CEN)",
    "Transit Router",
    "Smart Access Gateway (SAG)",
    "Global Accelerator (GA)",
    "PrivateLink",
    "Alibaba Cloud DNS",
    "CDN",
    "Dynamic Content Delivery Network (DCDN)"
   ]
  ],
  [
   "Security",
   [
    "Security Center",
    "Cloud Firewall",
    "Web Application Firewall (WAF)",
    "Anti-DDoS",
    "Bastionhost",
    "Key Management Service (KMS)",
    "Certificate Management Service",
    "Resource Access Management (RAM)",
    "IDaaS",
    "ActionTrail",
    "Data Security Center",
    "Content Moderation",
    "Fraud Detection"
   ]
  ],
  [
   "Messaging and Integration",
   [
    "ApsaraMQ for Kafka",
    "ApsaraMQ for RocketMQ",
    "ApsaraMQ for RabbitMQ",
    "ApsaraMQ for MQTT",
    "Simple Message Queue (MNS)",
    "EventBridge",
    "API Gateway",
    "Short Message Service (SMS)",
    "DirectMail"
   ]
  ],
  [
   "Analytics",
   [
    "MaxCompute",
    "DataWorks",
    "E-MapReduce (EMR)",
    "Realtime Compute for Apache Flink",
    "Hologres",
    "Elasticsearch",
    "OpenSearch",
    "Quick BI",
    "DataV",
    "Simple Log Service (SLS)",
    "Data Lake Formation"
   ]
  ],
  [
   "AI and Machine Learning",
   [
    "Platform for AI (PAI)",
    "Model Studio",
    "Qwen",
    "Intelligent Speech Interaction",
    "Machine Translation",
    "Image Search",
    "Vision Intelligence",
    "Optical Character Recognition (OCR)",
    "Natural Language Processing"
   ]
  ],
  [
   "Management and DevOps",
   [
    "CloudMonitor",
    "Application Real-Time Monitoring Service (ARMS)",
    "Resource Orchestration Service (ROS)",
    "CloudOps Orchestration Service (OOS)",
    "Cloud Config",
    "Resource Management",
    "Apsara DevOps",
    "Microservices Engine (MSE)"
   ]
  ],
  [
   "IoT and End User",
   [
    "IoT Platform",
    "Link IoT Edge",
    "Edge Node Service (ENS)",
    "Elastic Desktop Service (Wuying)",
    "ApsaraVideo VOD",
    "ApsaraVideo Live",
    "Real-Time Communication (RTC)",
    "Cloud Phone"
   ]
  ]
 ],
 "oci": [
  [
   "Compute",
   [
    "Compute (virtual machine)",
    "Compute (bare metal)",
    "Compute (GPU)",
    "Dedicated Virtual Machine Hosts",
    "Instance Pools",
    "Autoscaling",
    "Oracle Cloud VMware Solution",
    "Compute Cloud@Customer"
   ]
  ],
  [
   "Containers and Serverless",
   [
    "Kubernetes Engine (OKE)",
    "Container Instances",
    "Functions",
    "Container Registry"
   ]
  ],
  [
   "Storage",
   [
    "Object Storage",
    "Archive Storage",
    "Block Volume",
    "File Storage",
    "Storage Gateway",
    "Data Transfer"
   ]
  ],
  [
   "Databases",
   [
    "Autonomous Database",
    "Autonomous Transaction Processing",
    "Autonomous Data Warehouse",
    "Autonomous JSON Database",
    "Exadata Database Service",
    "Exadata Cloud@Customer",
    "Base Database Service",
    "MySQL HeatWave",
    "NoSQL Database Cloud",
    "PostgreSQL",
    "OCI Cache",
    "Globally Distributed Database",
    "Database Migration"
   ]
  ],
  [
   "Networking",
   [
    "Virtual Cloud Network (VCN)",
    "Load Balancer",
    "Network Load Balancer",
    "FastConnect",
    "Site-to-Site VPN",
    "DNS",
    "Dynamic Routing Gateway",
    "Internet Gateway",
    "NAT Gateway",
    "Service Gateway",
    "Private Endpoint",
    "Web Application Acceleration"
   ]
  ],
  [
   "Security",
   [
    "Identity and Access Management (IAM)",
    "Identity Domains",
    "Vault",
    "Key Management",
    "Certificates",
    "Cloud Guard",
    "Security Zones",
    "Bastion",
    "Data Safe",
    "Web Application Firewall",
    "Network Firewall",
    "Vulnerability Scanning",
    "Audit"
   ]
  ],
  [
   "Integration and Messaging",
   [
    "Oracle Integration",
    "API Gateway",
    "Streaming",
    "Queue",
    "Notifications",
    "Events",
    "Connector Hub",
    "GoldenGate",
    "Email Delivery"
   ]
  ],
  [
   "Analytics and AI",
   [
    "Analytics Cloud",
    "Data Integration",
    "Data Flow",
    "Data Catalog",
    "Big Data Service",
    "Data Science",
    "Generative AI",
    "Generative AI Agents",
    "AI Language",
    "AI Vision",
    "AI Speech",
    "Document Understanding",
    "Digital Assistant"
   ]
  ],
  [
   "Observability and Management",
   [
    "Monitoring",
    "Logging",
    "Logging Analytics",
    "Application Performance Monitoring",
    "Resource Manager",
    "DevOps",
    "OS Management Hub",
    "Cost Analysis",
    "Ops Insights"
   ]
  ],
  [
   "Application Development",
   [
    "APEX",
    "Visual Builder",
    "Blockchain Platform"
   ]
  ]
 ],
 "huawei": [
  [
   "Compute",
   [
    "Elastic Cloud Server (ECS)",
    "Bare Metal Server (BMS)",
    "Auto Scaling (AS)",
    "Image Management Service (IMS)",
    "Dedicated Host (DeH)",
    "FlexusX Instance"
   ]
  ],
  [
   "Containers and Serverless",
   [
    "Cloud Container Engine (CCE)",
    "Cloud Container Instance (CCI)",
    "Software Repository for Container (SWR)",
    "FunctionGraph",
    "Application Service Mesh (ASM)",
    "Ubiquitous Cloud Native Service (UCS)"
   ]
  ],
  [
   "Storage",
   [
    "Object Storage Service (OBS)",
    "Elastic Volume Service (EVS)",
    "Scalable File Service (SFS)",
    "Cloud Backup and Recovery (CBR)",
    "Storage Disaster Recovery Service (SDRS)",
    "Dedicated Distributed Storage Service (DSS)"
   ]
  ],
  [
   "Databases",
   [
    "GaussDB",
    "RDS for MySQL",
    "RDS for PostgreSQL",
    "RDS for SQL Server",
    "TaurusDB",
    "Document Database Service (DDS)",
    "GeminiDB",
    "Distributed Cache Service (DCS)",
    "Data Replication Service (DRS)",
    "Data Admin Service (DAS)"
   ]
  ],
  [
   "Networking",
   [
    "Virtual Private Cloud (VPC)",
    "Elastic Load Balance (ELB)",
    "NAT Gateway",
    "Elastic IP (EIP)",
    "Direct Connect",
    "Virtual Private Network (VPN)",
    "Cloud Connect (CC)",
    "Enterprise Router (ER)",
    "VPC Endpoint (VPCEP)",
    "Content Delivery Network (CDN)",
    "Domain Name Service (DNS)",
    "Global Accelerator (GA)"
   ]
  ],
  [
   "Security",
   [
    "Identity and Access Management (IAM)",
    "Web Application Firewall (WAF)",
    "Anti-DDoS",
    "Advanced Anti-DDoS",
    "Host Security Service (HSS)",
    "Cloud Firewall (CFW)",
    "Data Encryption Workshop (DEW)",
    "Cloud Certificate Manager (CCM)",
    "SecMaster",
    "Database Security Service (DBSS)",
    "Cloud Bastion Host (CBH)",
    "Data Security Center (DSC)"
   ]
  ],
  [
   "Integration and Messaging",
   [
    "Distributed Message Service for Kafka",
    "Distributed Message Service for RabbitMQ",
    "Distributed Message Service for RocketMQ",
    "API Gateway (APIG)",
    "ROMA Connect",
    "Simple Message Notification (SMN)",
    "EventGrid (EG)",
    "Message & SMS"
   ]
  ],
  [
   "Analytics and AI",
   [
    "ModelArts",
    "Pangu Models",
    "DataArts Studio",
    "MapReduce Service (MRS)",
    "Data Warehouse Service (DWS)",
    "Cloud Search Service (CSS)",
    "Data Lake Insight (DLI)",
    "Optical Character Recognition (OCR)",
    "Image Recognition",
    "Speech Interaction Service (SIS)",
    "Natural Language Processing (NLP)"
   ]
  ],
  [
   "Management and DevOps",
   [
    "Cloud Eye (CES)",
    "Cloud Trace Service (CTS)",
    "Log Tank Service (LTS)",
    "Application Operations Management (AOM)",
    "Application Performance Management (APM)",
    "Resource Formation Service (RFS)",
    "Config",
    "CodeArts",
    "Cloud Operations Center (COC)"
   ]
  ],
  [
   "End User and IoT",
   [
    "Workspace",
    "IoT Device Access (IoTDA)",
    "IoT Edge",
    "Cloud Phone Host (CPH)"
   ]
  ]
 ]
};
