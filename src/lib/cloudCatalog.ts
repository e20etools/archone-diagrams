/**
 * Names of common cloud services, offered while typing an object's technology so that the
 * same service is spelled the same way across the model. Each has the kind of object it
 * usually is. Names only: the providers' icons are not part of this app.
 */

export type CloudProvider = "AWS" | "Azure" | "Google Cloud";
export interface CloudService {
  provider: CloudProvider;
  name: string;
  typeId: string;
}

const list = (provider: CloudProvider, typeId: string, names: string[]): CloudService[] => names.map((name) => ({ provider, name, typeId }));

export const CLOUD_SERVICES: CloudService[] = [
  ...list("AWS", "service", ["AWS Lambda", "Amazon ECS", "AWS Fargate", "AWS App Runner", "AWS Step Functions"]),
  ...list("AWS", "server", ["Amazon EC2"]),
  ...list("AWS", "cluster", ["Amazon EKS"]),
  ...list("AWS", "database", ["Amazon RDS", "Amazon Aurora", "Amazon DynamoDB", "Amazon Redshift", "Amazon OpenSearch Service"]),
  ...list("AWS", "storage", ["Amazon S3", "Amazon EFS"]),
  ...list("AWS", "queue", ["Amazon SQS", "Amazon SNS", "Amazon Kinesis", "Amazon EventBridge", "Amazon MSK"]),
  ...list("AWS", "cache", ["Amazon ElastiCache"]),
  ...list("AWS", "gateway", ["Amazon API Gateway", "Elastic Load Balancing", "Amazon CloudFront", "Amazon Route 53"]),
  ...list("AWS", "network", ["AWS WAF", "Amazon VPC", "AWS Transit Gateway"]),
  ...list("AWS", "ai-model", ["Amazon Bedrock", "Amazon SageMaker"]),
  ...list("Azure", "service", ["Azure Functions", "Azure App Service", "Azure Container Apps", "Azure Logic Apps"]),
  ...list("Azure", "server", ["Azure Virtual Machines"]),
  ...list("Azure", "cluster", ["Azure Kubernetes Service"]),
  ...list("Azure", "database", ["Azure SQL Database", "Azure Cosmos DB", "Azure Database for PostgreSQL", "Azure Synapse Analytics", "Azure AI Search"]),
  ...list("Azure", "storage", ["Azure Blob Storage", "Azure Files"]),
  ...list("Azure", "queue", ["Azure Service Bus", "Azure Event Hubs", "Azure Event Grid", "Azure Queue Storage"]),
  ...list("Azure", "cache", ["Azure Cache for Redis"]),
  ...list("Azure", "gateway", ["Azure API Management", "Azure Application Gateway", "Azure Front Door", "Azure Load Balancer"]),
  ...list("Azure", "network", ["Azure Firewall", "Azure Virtual Network"]),
  ...list("Azure", "ai-model", ["Azure OpenAI Service", "Azure Machine Learning"]),
  ...list("Google Cloud", "service", ["Cloud Run", "Cloud Functions", "App Engine", "Workflows"]),
  ...list("Google Cloud", "server", ["Compute Engine"]),
  ...list("Google Cloud", "cluster", ["Google Kubernetes Engine"]),
  ...list("Google Cloud", "database", ["Cloud SQL", "Cloud Spanner", "Firestore", "Bigtable", "BigQuery", "AlloyDB"]),
  ...list("Google Cloud", "storage", ["Cloud Storage", "Filestore"]),
  ...list("Google Cloud", "queue", ["Pub/Sub", "Dataflow", "Eventarc"]),
  ...list("Google Cloud", "cache", ["Memorystore"]),
  ...list("Google Cloud", "gateway", ["Cloud Load Balancing", "Apigee", "Cloud CDN", "API Gateway"]),
  ...list("Google Cloud", "network", ["Cloud Armor", "Virtual Private Cloud"]),
  ...list("Google Cloud", "ai-model", ["Vertex AI"]),
];

const BY_NAME = new Map(CLOUD_SERVICES.map((s) => [s.name.toLowerCase(), s]));

/** The catalogue entry for a technology as typed, or undefined when it is not a cloud service the catalogue knows. */
export const cloudService = (technology: string): CloudService | undefined => BY_NAME.get(technology.trim().toLowerCase());

/** Services to offer for an object of a kind: those that usually are that kind first, then the rest. */
export function cloudSuggestions(typeId: string): CloudService[] {
  return [...CLOUD_SERVICES].sort((a, b) => Number(b.typeId === typeId) - Number(a.typeId === typeId) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
