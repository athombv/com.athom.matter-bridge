// The backend represents wildcards numerically; concrete controller paths use numeric IDs too.
export function matchesAttributePath(subscription, report) {
  if (!('attributeId' in subscription)) {
    return false;
  }

  const matchesEndpoint =
    subscription.endpointId === 0xffff || subscription.endpointId === report.endpointId;
  const matchesCluster =
    subscription.clusterId === 0xffffffff || subscription.clusterId === report.clusterId;
  const matchesAttribute =
    subscription.attributeId === 0xffffffff || subscription.attributeId === report.attributeId;

  return matchesEndpoint && matchesCluster && matchesAttribute;
}
