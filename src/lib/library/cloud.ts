import { CLOUD_NAMES } from "./cloudNames";

/**
 * Cloud providers and how each of their services is shown. A service is drawn with an icon
 * for what it does (a database, a queue, a firewall), not with the provider's artwork, and
 * the provider is named beside it. The kind and the icon come from the service's name first
 * and its section second, so "Cloud SQL" is a database wherever the provider filed it.
 */

export interface Provider {
  id: string;
  label: string;
  short: string;
  color: string;
}

export const PROVIDERS: Provider[] = [
  { id: "aws", label: "Amazon Web Services", short: "AWS", color: "#C2410C" },
  { id: "azure", label: "Microsoft Azure", short: "Azure", color: "#0369A1" },
  { id: "gcp", label: "Google Cloud", short: "Google Cloud", color: "#15803D" },
  { id: "oci", label: "Oracle Cloud Infrastructure", short: "OCI", color: "#B91C1C" },
  { id: "ibm", label: "IBM Cloud", short: "IBM Cloud", color: "#1D4ED8" },
  { id: "alibaba", label: "Alibaba Cloud", short: "Alibaba Cloud", color: "#EA580C" },
  { id: "huawei", label: "Huawei Cloud", short: "Huawei Cloud", color: "#BE123C" },
];

interface Look {
  kind: string;
  icon: string;
  profile: string;
}

/** Read top to bottom; the first rule whose pattern matches the name wins. */
const BY_NAME: [RegExp, Look][] = [
  [/\b(registry|registries|artifact ?registry|codeartifact|container registry|ecr|acr|swr)\b/i, { kind: "storage", icon: "Package", profile: "cloud-storage" }],
  [/(web application firewall|\bwaf\b)/i, { kind: "gateway", icon: "ShieldHalf", profile: "cloud-security" }],
  [/(ddos|anti-?bot|\bshield\b|cloud armor)/i, { kind: "network", icon: "ShieldBan", profile: "cloud-security" }],
  [/firewall/i, { kind: "network", icon: "BrickWallFire", profile: "cloud-security" }],
  [/(api gateway|api management|apigee|\bapig\b|cloud endpoints|apigateway)/i, { kind: "gateway", icon: "Split", profile: "cloud-network" }],
  [/(load balanc|\b(alb|clb|nlb|elb|slb)\b|front ?door|application gateway|traffic manager|global accelerator|\bga\b)/i, { kind: "gateway", icon: "Split", profile: "cloud-network" }],
  [/(\bcdn\b|cloudfront|content delivery|edge (network|acceleration)|web application acceleration)/i, { kind: "gateway", icon: "Globe", profile: "cloud-network" }],
  [/(\bdns\b|route 53|domains?\b|private ?zone)/i, { kind: "network", icon: "BookUser", profile: "cloud-network" }],
  [/(vpn|direct ?connect|expressroute|express ?route|interconnect|fastconnect|direct link|express connect|cloud connect|peering|satellite)/i, { kind: "network", icon: "Cable", profile: "cloud-network" }],
  [/(\bvpc\b|\bvcn\b|virtual (private )?(cloud|network)|vnet|subnet|transit (gateway|router)|nat\b|nat gateway|private ?link|private (endpoint|service connect)|virtual wan|network (manager|interface|security)|\bip\b|internet gateway|service gateway|routing gateway|enterprise router|\beip\b|elastic ip)/i, { kind: "network", icon: "Network", profile: "cloud-network" }],
  [/(redis|memcache|cache|memorystore|memorydb|\btair\b|\bdcs\b)/i, { kind: "cache", icon: "Zap", profile: "cloud-database" }],
  [/(warehouse|redshift|bigquery|synapse|analyticdb|maxcompute|\bdws\b|hologres)/i, { kind: "database", icon: "Warehouse", profile: "cloud-database" }],
  [/(search|kendra|opensearch|elasticsearch|\bcss\b)/i, { kind: "database", icon: "Search", profile: "cloud-database" }],
  [/(\bsql\b|sql ?server|mysql|postgre|mariadb|database|\bdb\b|db2|dynamo|aurora|cosmos|spanner|bigtable|firestore|datastore|cassandra|mongo|neptune|timestream|documentdb|keyspaces|cloudant|gaussdb|geminidb|taurusdb|polardb|lindorm|oceanbase|tablestore|clickhouse|hbase|\brds\b|\bdds\b|heatwave|nosql|autonomous|exadata|alloydb|etcd|ledger)/i, { kind: "database", icon: "Database", profile: "cloud-database" }],
  [/(queue|\bsqs\b|\bsns\b|notification|service bus|event ?hubs?|event ?grid|eventbridge|eventarc|pub\/?sub|kafka|rabbitmq|rocketmq|mqtt|\bmq\b|\bmns\b|\bsmn\b|messag|streaming|event streams|kinesis|\bmsk\b|events?\b)/i, { kind: "queue", icon: "RadioTower", profile: "cloud-messaging" }],
  [/(kubernetes|\beks\b|\baks\b|\bgke\b|\back\b|\boke\b|\bcce\b|openshift|service mesh|\basm\b|\becs\b(?! \()|container (service|apps?|instances?|engine)|fargate|anthos|arc kubernetes)/i, { kind: "cluster", icon: "Container", profile: "cloud-container" }],
  [/(lambda|function|serverless|cloud run|app runner|code engine|cloudflow|workflows?\b|step functions|logic apps?)/i, { kind: "service", icon: "SquareFunction", profile: "cloud-compute" }],
  [/(glacier|archive|backup|disaster recovery|\bcbr\b|\bhbr\b|recovery vault|backup vault)/i, { kind: "storage", icon: "ArchiveArrowUp", profile: "cloud-storage" }],
  [/(\bs3\b|blob|object storage|\boss\b|\bobs\b|cloud storage|bucket|file (storage|share|system|cache)|\bfiles\b|\bnas\b|fsx|\befs\b|filestore|hyperdisk|disk|volume|block (store|storage)|\bevs\b|\bsfs\b|storage)/i, { kind: "storage", icon: "HardDrive", profile: "cloud-storage" }],
  [/(virtual machine|\bvms?\b|vmss|\bec2\b|compute engine|bare metal|\becs\b|elastic compute|virtual server|dedicated host|lightsail|instance|outposts|spot|sole-tenant|\bhpc\b|e-hpc|batch|gpu|\btpu\b|vmware|application server|beanstalk|app engine|app service|web apps?\b|cloud services)/i, { kind: "server", icon: "Server", profile: "cloud-compute" }],
  [/(agent|assistant|copilot|\bbot\b|chatbot|orchestrate|\bq\b|amazon q|digital assistant|lex|dialogflow)/i, { kind: "ai-agent", icon: "Bot", profile: "cloud-ai" }],
  [/(translat)/i, { kind: "ai-model", icon: "Languages", profile: "cloud-ai" }],
  [/(speech|transcri|polly|voice|\bsis\b)/i, { kind: "ai-model", icon: "Mic", profile: "cloud-ai" }],
  [/(vision|rekognition|image recognition|video (intelligence|indexer|analyzer)|face|panorama)/i, { kind: "ai-model", icon: "ScanEye", profile: "cloud-ai" }],
  [/(textract|\bocr\b|document (ai|understanding|intelligence)|form recognizer)/i, { kind: "ai-model", icon: "ScanText", profile: "cloud-ai" }],
  [/(bedrock|openai|gemini|watsonx|\bnova\b|qwen|pangu|generative ai|model studio|foundry|language model|\bllm\b)/i, { kind: "ai-model", icon: "BrainCircuit", profile: "cloud-ai" }],
  [/(sagemaker|machine learning|vertex|modelarts|\bpai\b|data science|automl|ai platform|watson (studio|machine)|cognitive|comprehend|natural language|\bnlp\b|forecast|personalize|recommend|fraud)/i, { kind: "ai-model", icon: "Brain", profile: "cloud-ai" }],
  [/(identity|\biam\b|\bram\b|directory|entra|\bad\b|active directory|cognito|single sign|\bsso\b|app id|idaas|managed identit|users|groups|verified id|external id|access management)/i, { kind: "service", icon: "IdCard", profile: "cloud-security" }],
  [/(\bkms\b|key (vault|management|protect)|secret|vault|\bhsm\b|crypto|certificate|\bdew\b|\bccm\b|signer)/i, { kind: "service", icon: "KeyRound", profile: "cloud-security" }],
  [/(security|guardduty|defender|sentinel|cloud guard|inspector|macie|detective|secmaster|bastion|compliance|threat|sensitive data|data loss|\bdlp\b|policy|guard|audit|trail)/i, { kind: "service", icon: "ShieldCheck", profile: "cloud-security" }],
  [/(monitor|watch|logging|\blogs?\b|log (analytics|service|tank|streaming)|trace|tracing|x-ray|insights|grafana|prometheus|telemetry|\bapm\b|\barms\b|cloud eye|\bces\b|\blts\b|\baom\b|observab|health|profiler|error reporting|diagnostic)/i, { kind: "service", icon: "Activity", profile: "cloud-service" }],
  [/(cost|budget|billing|savings|reserved|finops|pricing)/i, { kind: "service", icon: "Wallet", profile: "cloud-service" }],
  [/(migrat|transfer|datasync|snowball|mover|data box|transport)/i, { kind: "service", icon: "Truck", profile: "cloud-service" }],
  [/(devops|pipeline|codebuild|codedeploy|build|deploy|repos?|source|codecatalyst|codearts|test|dev box|dev tunnels|load testing|chaos|fault injection)/i, { kind: "service", icon: "GitBranch", profile: "cloud-service" }],
  [/(iot|device|edge|greengrass|sitewise|twinmaker|sphere|rtos|freertos|fleetwise)/i, { kind: "service", icon: "Cpu", profile: "cloud-service" }],
  [/(email|mail|\bses\b|\bsms\b|pinpoint|communication|chime|connect\b|contact center|call)/i, { kind: "service", icon: "Mail", profile: "cloud-service" }],
  [/(desktop|workspaces?\b|wuying|cloud phone|thin client|dcv)/i, { kind: "server", icon: "MonitorCloud", profile: "cloud-compute" }],
  [/(media|video|live\b|stream|elemental|ivs|vod|rtc)/i, { kind: "service", icon: "Clapperboard", profile: "cloud-service" }],
  [/(analytic|athena|glue|emr|mapreduce|dataflow|dataproc|data ?fusion|data ?factory|databricks|data lake|lake formation|dataplex|dataworks|dataarts|\bdli\b|\bmrs\b|flink|composer|airflow|data integration|data catalog|catalog|quicksight|\bquick\b|looker|power bi|quick bi|datav|fabric|purview|bi\b)/i, { kind: "service", icon: "ChartColumn", profile: "cloud-service" }],
  [/(blockchain)/i, { kind: "service", icon: "Link", profile: "cloud-service" }],
  [/(quantum|braket)/i, { kind: "service", icon: "Atom", profile: "cloud-service" }],
  [/(config|resource|formation|template|orchestrat|organizations|control tower|landing zone|systems manager|automation|management|governance|policy|advisor|catalog|scheduler|tasks)/i, { kind: "service", icon: "Settings", profile: "cloud-service" }],
];

/** For names no rule recognises: what the provider's section says the service is. */
const BY_SECTION: [RegExp, Look][] = [
  [/(ai|artificial|machine learning)/i, { kind: "ai-model", icon: "BrainCircuit", profile: "cloud-ai" }],
  [/analytic/i, { kind: "service", icon: "ChartColumn", profile: "cloud-service" }],
  [/(integration|messaging)/i, { kind: "service", icon: "Workflow", profile: "cloud-messaging" }],
  [/compute|vmware|azure stack/i, { kind: "server", icon: "Server", profile: "cloud-compute" }],
  [/container/i, { kind: "cluster", icon: "Container", profile: "cloud-container" }],
  [/(database|^data$)/i, { kind: "database", icon: "Database", profile: "cloud-database" }],
  [/(developer|devops|ci)/i, { kind: "service", icon: "GitBranch", profile: "cloud-service" }],
  [/(network|content delivery)/i, { kind: "network", icon: "Network", profile: "cloud-network" }],
  [/(security|identity)/i, { kind: "service", icon: "ShieldCheck", profile: "cloud-security" }],
  [/storage/i, { kind: "storage", icon: "HardDrive", profile: "cloud-storage" }],
  [/(management|monitor|operations|observability|governance)/i, { kind: "service", icon: "Settings", profile: "cloud-service" }],
  [/(iot|internet of things)/i, { kind: "service", icon: "Cpu", profile: "cloud-service" }],
  [/(end user|desktop)/i, { kind: "server", icon: "MonitorCloud", profile: "cloud-compute" }],
  [/(web|mobile|front end|app services|business applications|application development|power platform|games|mixed reality)/i, { kind: "application", icon: "AppWindow", profile: "cloud-service" }],
  [/media/i, { kind: "service", icon: "Clapperboard", profile: "cloud-service" }],
  [/migrat/i, { kind: "service", icon: "Truck", profile: "cloud-service" }],
  [/(financial|cost)/i, { kind: "service", icon: "Wallet", profile: "cloud-service" }],
  [/hybrid|multicloud/i, { kind: "service", icon: "CloudCog", profile: "cloud-service" }],
];
const FALLBACK: Look = { kind: "service", icon: "Cloud", profile: "cloud-service" };

export function cloudLook(section: string, name: string): Look {
  for (const [pattern, look] of BY_NAME) if (pattern.test(name)) return look;
  for (const [pattern, look] of BY_SECTION) if (pattern.test(section)) return look;
  return FALLBACK;
}

export { CLOUD_NAMES };
