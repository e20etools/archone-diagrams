import type { LibraryComponent } from "../library";
import { generalComponent, providerComponent, type Cloud } from "./model";

/**
 * What a cloud resource type is, whichever tool names it. Terraform says aws_db_instance,
 * CloudFormation and AWS Config say AWS::RDS::DBInstance, Resource Explorer says rds:db, an ARN
 * says rds:db:name. Each is reduced to letters and digits (dbinstance, rdsdbinstance, rdsdb)
 * and looked up here. A zone is a network that other resources sit inside; minor resources
 * (policies, attachments, rules, interfaces) are not drawn, but what they join is joined.
 */

type Role = "zone" | "minor";
interface Entry {
  keys: string[];
  /** The library's name for it at the provider, or a general component's name after "general:". */
  library: string;
  role?: Role;
}

const AWS: Entry[] = [
  { keys: ["instance", "ec2instance", "spotinstancerequest"], library: "EC2" },
  { keys: ["autoscalinggroup", "autoscalingautoscalinggroup"], library: "EC2 Auto Scaling" },
  { keys: ["lb", "alb", "elb", "elasticloadbalancingv2loadbalancer", "elasticloadbalancingloadbalancer", "elbv2loadbalancer"], library: "Elastic Load Balancing" },
  { keys: ["lambdafunction"], library: "Lambda" },
  { keys: ["dbinstance", "rdsdbinstance", "rdsdb"], library: "RDS" },
  { keys: ["rdscluster", "rdsdbcluster", "rdscluster"], library: "Aurora" },
  { keys: ["dynamodbtable"], library: "DynamoDB" },
  { keys: ["s3bucket", "s3"], library: "Simple Storage Service (S3)" },
  { keys: ["sqsqueue"], library: "Simple Queue Service" },
  { keys: ["snstopic"], library: "Simple Notification Service" },
  { keys: ["apigatewayrestapi", "apigatewayv2api", "apigatewayrestapis", "apigatewayapis", "serverlessapi", "serverlesshttpapi"], library: "API Gateway" },
  { keys: ["ecscluster", "ecsservice"], library: "Elastic Container Service" },
  { keys: ["ekscluster"], library: "Elastic Kubernetes Service" },
  { keys: ["ecrrepository"], library: "Elastic Container Registry" },
  { keys: ["elasticachecluster", "elasticachereplicationgroup", "elasticachecachecluster", "elasticacheserverlesscache"], library: "ElastiCache" },
  { keys: ["cloudfrontdistribution"], library: "CloudFront" },
  { keys: ["route53zone", "route53hostedzone"], library: "Route 53" },
  { keys: ["kinesisstream"], library: "Kinesis Data Streams" },
  { keys: ["kinesisfirehosedeliverystream", "firehosedeliverystream"], library: "Data Firehose" },
  { keys: ["efsfilesystem", "elasticfilesystemfilesystem"], library: "Elastic File System" },
  { keys: ["ebsvolume", "ec2volume"], library: "Elastic Block Store" },
  { keys: ["secretsmanagersecret"], library: "Secrets Manager" },
  { keys: ["kmskey"], library: "Key Management Service" },
  { keys: ["cognitouserpool"], library: "Cognito" },
  { keys: ["wafv2webacl", "wafwebacl", "wafregionalwebacl"], library: "WAF" },
  { keys: ["sfnstatemachine", "stepfunctionsstatemachine", "statesstatemachine", "serverlessstatemachine"], library: "Step Functions" },
  { keys: ["cloudwatcheventbus", "eventseventbus", "eventbridgeeventbus"], library: "EventBridge" },
  { keys: ["mskcluster", "kafkacluster"], library: "Managed Streaming for Apache Kafka" },
  { keys: ["redshiftcluster"], library: "Redshift" },
  { keys: ["opensearchdomain", "elasticsearchdomain", "esdomain"], library: "OpenSearch Service" },
  { keys: ["elasticbeanstalkenvironment"], library: "Elastic Beanstalk" },
  { keys: ["batchcomputeenvironment"], library: "Batch" },
  { keys: ["gluejob"], library: "Glue" },
  { keys: ["networkfirewallfirewall"], library: "Network Firewall" },
  { keys: ["ec2transitgateway", "transitgateway"], library: "Transit Gateway" },
  { keys: ["mqbroker", "amazonmqbroker"], library: "MQ" },
  { keys: ["appsyncgraphqlapi"], library: "AppSync" },
  { keys: ["docdbcluster", "docdbdbcluster"], library: "DocumentDB" },
  { keys: ["neptunecluster", "neptunedbcluster"], library: "Neptune" },
  { keys: ["sagemakerendpoint", "sagemakernotebookinstance", "sagemakerdomain"], library: "SageMaker" },
  { keys: ["vpc", "ec2vpc"], library: "VPC", role: "zone" },
  { keys: ["subnet", "ec2subnet"], library: "general:Cloud VPC subnet", role: "zone" },
  { keys: ["internetgateway", "ec2internetgateway"], library: "general:Internet" },
  { keys: ["natgateway", "ec2natgateway"], library: "general:NAT gateway" },
  { keys: ["vpnconnection", "ec2vpnconnection"], library: "Site-to-Site VPN" },
  { keys: ["dxconnection", "directconnectconnection"], library: "Direct Connect" },
];

const AZURE: Entry[] = [
  { keys: ["computevirtualmachines", "linuxvirtualmachine", "windowsvirtualmachine", "virtualmachine"], library: "Virtual Machine" },
  { keys: ["computevirtualmachinescalesets", "linuxvirtualmachinescaleset", "windowsvirtualmachinescaleset", "virtualmachinescaleset", "orchestratedvirtualmachinescaleset"], library: "VM Scale Sets" },
  { keys: ["websites", "linuxwebapp", "windowswebapp", "appservice", "webapp"], library: "App Services" },
  { keys: ["websitesfunctionapp", "linuxfunctionapp", "windowsfunctionapp", "functionapp"], library: "Function Apps" },
  { keys: ["webserverfarms", "serviceplan", "appserviceplan"], library: "App Service Plans" },
  { keys: ["sqlserversdatabases", "mssqldatabase", "sqldatabase"], library: "SQL Database" },
  { keys: ["sqlservers", "mssqlserver", "sqlserver"], library: "SQL Server" },
  { keys: ["sqlmanagedinstances", "mssqlmanagedinstance"], library: "SQL Managed Instance" },
  { keys: ["documentdbdatabaseaccounts", "cosmosdbaccount"], library: "Cosmos DB" },
  { keys: ["dbforpostgresqlflexibleservers", "postgresqlflexibleserver", "dbforpostgresqlservers", "postgresqlserver"], library: "Database PostgreSQL Server" },
  { keys: ["dbformysqlflexibleservers", "mysqlflexibleserver", "dbformysqlservers", "mysqlserver"], library: "Database MySQL Server" },
  { keys: ["storagestorageaccounts", "storageaccount"], library: "Storage Accounts" },
  { keys: ["keyvaultvaults", "keyvault"], library: "Key Vaults" },
  { keys: ["containerservicemanagedclusters", "kubernetescluster"], library: "Kubernetes Services" },
  { keys: ["redhatopenshiftopenshiftclusters", "redhatopenshiftcluster"], library: "Red Hat OpenShift" },
  { keys: ["containerregistryregistries", "containerregistry"], library: "Container Registries" },
  { keys: ["containerinstancecontainergroups", "containergroup"], library: "Container Instances" },
  { keys: ["appcontainerapps", "containerapp"], library: "general:Container" },
  { keys: ["networkloadbalancers", "lb"], library: "Load Balancers" },
  { keys: ["networkapplicationgateways", "applicationgateway"], library: "Application Gateways" },
  { keys: ["networkfrontdoors", "frontdoor", "cdnprofiles", "cdnfrontdoorprofile"], library: "Front Door and CDN profiles" },
  { keys: ["networkazurefirewalls", "firewall"], library: "Firewalls" },
  { keys: ["networkvirtualnetworkgateways", "virtualnetworkgateway"], library: "Virtual Network Gateways" },
  { keys: ["servicebusnamespaces", "servicebusnamespace"], library: "Service Bus" },
  { keys: ["eventhubnamespaces", "eventhubnamespace"], library: "Event Hubs" },
  { keys: ["eventgridtopics", "eventgridtopic"], library: "Event Grid Topics" },
  { keys: ["cacheredis", "rediscache", "managedredis"], library: "Cache Redis" },
  { keys: ["apimanagementservice", "apimanagement"], library: "API Management Services" },
  { keys: ["logicworkflows", "logicappworkflow", "logicappstandard"], library: "Logic Apps" },
  { keys: ["datafactoryfactories", "datafactory"], library: "Data Factories" },
  { keys: ["synapseworkspaces", "synapseworkspace"], library: "Synapse Analytics" },
  { keys: ["databricksworkspaces", "databricksworkspace"], library: "Databricks" },
  { keys: ["insightscomponents", "applicationinsights"], library: "Application Insights" },
  { keys: ["operationalinsightsworkspaces", "loganalyticsworkspace"], library: "Log Analytics Workspaces" },
  { keys: ["cognitiveservicesaccounts", "cognitiveaccount"], library: "Cognitive Services" },
  { keys: ["searchsearchservices", "searchservice"], library: "Search Services" },
  { keys: ["networkvirtualnetworks", "virtualnetwork"], library: "Virtual Networks", role: "zone" },
  { keys: ["networkvirtualnetworkssubnets", "subnet"], library: "general:Cloud VPC subnet", role: "zone" },
];

const GCP: Entry[] = [
  { keys: ["computeinstance"], library: "Compute Engine" },
  { keys: ["containercluster"], library: "Google Kubernetes Engine (GKE)" },
  { keys: ["sqladmininstance", "sqldatabaseinstance"], library: "Cloud SQL" },
  { keys: ["storagebucket"], library: "Cloud Storage" },
  { keys: ["pubsubtopic"], library: "Pub/Sub" },
  { keys: ["runservice", "cloudrunservice", "cloudrunv2service"], library: "Cloud Run" },
  { keys: ["cloudfunctionsfunction", "cloudfunctions2function", "cloudfunctionscloudfunction"], library: "Cloud Functions" },
  { keys: ["bigquerydataset"], library: "BigQuery" },
  { keys: ["redisinstance"], library: "Memorystore" },
  { keys: ["spannerinstance"], library: "Spanner" },
  { keys: ["bigtableinstance", "bigtableadmininstance"], library: "Bigtable" },
  { keys: ["firestoredatabase"], library: "Firestore" },
  { keys: ["alloydbcluster"], library: "AlloyDB" },
  { keys: ["computeforwardingrule", "computeglobalforwardingrule"], library: "Cloud Load Balancing" },
  { keys: ["computerouter"], library: "Cloud Router" },
  { keys: ["computerouternat"], library: "Cloud NAT" },
  { keys: ["computevpngateway", "computehavpngateway"], library: "Cloud VPN" },
  { keys: ["secretmanagersecret"], library: "Secret Manager" },
  { keys: ["cloudkmskeyring", "cloudkmscryptokey"], library: "Key Management Service" },
  { keys: ["artifactregistryrepository"], library: "Artifact Registry" },
  { keys: ["dataflowjob"], library: "Dataflow" },
  { keys: ["dataproccluster"], library: "Dataproc" },
  { keys: ["composerenvironment"], library: "Cloud Composer" },
  { keys: ["filestoreinstance"], library: "Filestore" },
  { keys: ["appengineapplication"], library: "App Engine" },
  { keys: ["apigeeorganization", "apigeeinstance"], library: "Apigee API Platform" },
  { keys: ["computenetwork"], library: "Virtual Private Cloud", role: "zone" },
  { keys: ["computesubnetwork"], library: "general:Cloud VPC subnet", role: "zone" },
];

const TABLES: Partial<Record<Cloud, Entry[]>> = { aws: AWS, azure: AZURE, gcp: GCP };
const INDEX = new Map<Cloud, Map<string, Entry>>();
for (const [cloud, entries] of Object.entries(TABLES) as [Cloud, Entry[]][]) {
  const map = new Map<string, Entry>();
  for (const entry of entries) for (const key of entry.keys) if (!map.has(key)) map.set(key, entry);
  INDEX.set(cloud, map);
}

/** Resources that are not drawn: settings, policies and the glue between things. */
const MINOR: Record<Cloud, RegExp> = {
  aws: /^(iam|.*policy|.*attachment|.*association|.*rule|.*permission|.*version|.*alias|route$|routetable|ec2routetable|.*securitygroup|ec2securitygroup|.*listener|.*targetgroup|.*networkinterface|ec2networkinterface|eip|ec2eip|keypair|.*launchtemplate|.*launchconfiguration|cloudwatch|logs|.*loggroup|s3bucket.+|.*subscription|.*deployment|.*stage|.*integration|.*resource$|.*method|.*eventsourcemapping|.*tag$|ssm|.*parameter$|acm|.*certificate|.*record$|.*recordset)/,
  azure: /^(resources|resourcegroup|.*roleassignment|.*roledefinition|.*lock|.*diagnosticsetting|.*networkinterfaces?$|networknetworkinterfaces|.*networksecuritygroups?$|networknetworksecuritygroups|.*publicipaddress(es)?$|networkpublicipaddresses|.*association|.*privateendpoints?$|.*privatednszone.*|.*routetables?$|.*extensions?$|.*diagnostic.*|.*firewallrule|.*virtualnetworklink|.*policy.*|insightsactiongroups|insightsmetricalerts|.*alert.*|managedidentityuserassignedidentities|userassignedidentity|computedisks|manageddisk|.*vnetintegration|.*connection$)/,
  gcp: /^(.*iam.*|resourcemanager.*|serviceusage.*|.*firewall$|computefirewall|computeaddress|computeglobaladdress|computeinstancegroup.*|computeinstancetemplate|computedisk|computeimage|computesnapshot|computebackendservice|computeurlmap|computetarget.*|computehealthcheck|computesslcertificate|pubsubsubscription|containernodepool|bigquerytable|.*policy.*|logging.*|monitoring.*|.*binding|.*member)/,
  oci: /$^/,
  ibm: /$^/,
  alibaba: /$^/,
  huawei: /$^/,
};

const flat = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ResourceKind {
  component?: LibraryComponent;
  role?: Role;
}

/** What a provider's resource type is, from any of the spellings above. */
export function cloudResource(cloud: Cloud, type: string): ResourceKind {
  const key = flat(type);
  const table = INDEX.get(cloud);
  const entry = table?.get(key) ?? table?.get(key.replace(/s$/, "")) ?? table?.get(`${key}s`);
  if (entry) {
    const component = entry.library.startsWith("general:") ? generalComponent(entry.library.slice(8)) : providerComponent(cloud, entry.library);
    return { component, role: entry.role };
  }
  return MINOR[cloud].test(key) ? { role: "minor" } : {};
}

/* ---------- spelling each tool's type as a key ---------- */

/** aws_db_instance → db_instance; AWS::RDS::DBInstance → RDS::DBInstance; rds:db stays. */
export function awsType(type: string): string {
  if (/^aws_/i.test(type)) return type.slice(4);
  if (/^AWS::/i.test(type)) return type.slice(5);
  return type;
}

/** The service and resource kind an ARN names: arn:aws:rds:eu-west-1:1:db:orders → rds:db. */
export function arnType(arn: string): string {
  const m = /^arn:[^:]+:([^:]+):[^:]*:[^:]*:(.*)$/.exec(arn);
  if (!m) return "";
  const resource = m[2].includes("/") ? m[2].split("/")[0] : m[2].includes(":") ? m[2].split(":")[0] : "";
  return `${m[1]}:${resource}`;
}

/** azurerm_linux_virtual_machine → linux_virtual_machine; Microsoft.Compute/virtualMachines → Compute/virtualMachines. */
export function azureType(type: string): string {
  if (/^azurerm_/i.test(type)) return type.slice(8);
  return type.replace(/^Microsoft\./i, "").replace(/\/Microsoft\./gi, "/");
}

/** google_compute_instance → compute_instance; compute.googleapis.com/Instance → compute/Instance. */
export function gcpType(type: string): string {
  if (/^google_/i.test(type)) return type.slice(7).replace(/^beta_/, "");
  return type.replace(/\.googleapis\.com/i, "");
}

/** The cloud a Terraform or Pulumi type belongs to. */
export function cloudOf(type: string): Cloud | null {
  if (/^(aws_|AWS::|aws:)/i.test(type)) return "aws";
  if (/^(azurerm_|Microsoft\.|azure-native:|azure:)/i.test(type)) return "azure";
  if (/^(google_|gcp:|[a-z]+\.googleapis\.com\/)/i.test(type)) return "gcp";
  if (/^(oci_|oci:)/i.test(type)) return "oci";
  if (/^(ibm_)/i.test(type)) return "ibm";
  if (/^(alicloud_)/i.test(type)) return "alibaba";
  if (/^(huaweicloud_)/i.test(type)) return "huawei";
  return null;
}

/** The provider type of a resource in a cloud's own spelling, ready for cloudResource. */
export function cloudKey(cloud: Cloud, type: string): string {
  if (cloud === "aws") return awsType(type);
  if (cloud === "azure") return azureType(type);
  if (cloud === "gcp") return gcpType(type);
  return type.replace(/^[a-z]+_/, "");
}

/** What a resource of another cloud the library covers is, by the words of its type. */
export function otherCloudResource(cloud: Cloud, type: string): ResourceKind {
  const words = type.replace(/^[a-z]+_/, "").replace(/_/g, " ");
  const component = providerComponent(cloud, words);
  return component ? { component } : {};
}

/* ---------- Kubernetes ---------- */

const K8S: Record<string, { library?: string; role?: Role }> = {
  deployment: { library: "Deployment" },
  deploymentconfig: { library: "Deployment" },
  statefulset: { library: "StatefulSet" },
  daemonset: { library: "DaemonSet" },
  job: { library: "Job" },
  cronjob: { library: "Job" },
  pod: { library: "Pod" },
  replicaset: { role: "minor" },
  service: { library: "Kubernetes service" },
  ingress: { library: "Ingress controller" },
  route: { library: "OpenShift Route" },
  gateway: { library: "Gateway API" },
  httproute: { library: "Gateway API" },
  configmap: { library: "Config map" },
  secret: { library: "Kubernetes secret" },
  persistentvolumeclaim: { library: "Persistent volume" },
  persistentvolume: { library: "Persistent volume" },
  namespace: { library: "Namespace", role: "zone" },
  horizontalpodautoscaler: { library: "Horizontal Pod Autoscaler" },
  customresourcedefinition: { library: "Custom resource definition" },
  serviceaccount: { role: "minor" },
  role: { role: "minor" },
  rolebinding: { role: "minor" },
  clusterrole: { role: "minor" },
  clusterrolebinding: { role: "minor" },
  networkpolicy: { role: "minor" },
  poddisruptionbudget: { role: "minor" },
  limitrange: { role: "minor" },
  resourcequota: { role: "minor" },
  storageclass: { role: "minor" },
  endpoints: { role: "minor" },
  endpointslice: { role: "minor" },
};

/** What a Kubernetes kind is. */
export function kubernetesKind(kind: string): ResourceKind {
  const entry = K8S[flat(kind)];
  if (!entry) return {};
  return { component: entry.library ? generalComponent(entry.library) : undefined, role: entry.role };
}
