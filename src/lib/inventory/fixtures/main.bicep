param location string = resourceGroup().location
resource vnet 'Microsoft.Network/virtualNetworks@2023-04-01' = {
  name: 'shop-vnet'
  location: location
}
resource aks 'Microsoft.ContainerService/managedClusters@2024-02-01' = {
  name: 'shop-aks'
  location: location
  properties: {
    agentPoolProfiles: [ { vnetSubnetID: '${vnet.id}/subnets/aks' } ]
  }
}
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'shopacr'
  location: location
}
module monitoring './monitoring.bicep' = {
  name: 'monitoring'
  params: { clusterId: aks.id }
}
