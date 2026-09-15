# Controller observations

## Home Assistant bulk discovery

Observed with Home Assistant 2026.9.2 and Matter Server 1.4.0, using the Matter.js server.
Adding bridged endpoints while already paired can cause `endpoint_added_callback` to raise
`KeyError`; a reconnect may recover discovery and leave an unavailable duplicate entity.

The inspected paths explain a possible event ordering:

1. Matter Server's `WebSocketControllerHandler.ts` schedules `node_updated` through
   `sendNodeDetailsEvent`, which batches node snapshots for `setImmediate`.
2. Its `nodeEndpointAdded` listener sends `endpoint_added` immediately.
3. The Python Matter client forwards that event without constructing a new endpoint.
4. Home Assistant's `components/matter/adapter.py` indexes `node.endpoints[endpoint_id]` directly.
   If the snapshot has not arrived yet, that entry is missing and the callback fails.

This source trace is consistent with the observed exception. It is not a packet-level proof of every
failed interview or the duplicate entity's exact origin. The documented WebSocket protocol carries
a full snapshot in `node_updated`; `endpoint_added` contains only the node and endpoint IDs.
See the [Matter Server protocol](https://github.com/matter-js/matterjs-server/blob/main/docs/websockets_api.md).
An [upstream Home Assistant issue](https://github.com/home-assistant/core/issues/180171) reports the
same exception across other bridged devices. Its existence does not prove every report has one cause.

The bridge test adds 50 synthetic devices while paired, checks all final descriptor relationships
and values, and observes subsequent reports. This verifies the direct Matter boundary. It does not
claim to fix ordering in the server/client WebSocket connection. No controller code, installed
services, pairings or entity registry entries were changed as part of this investigation.

To verify a controller-side fix, capture a new bulk-add session and require each endpoint-added
notification to have a corresponding cached endpoint, with no callback errors or duplicate entities.
Preserve private captures outside this public repository. Reloading the Matter integration can
refresh discovery; an orphaned unavailable entity should only be removed after checking that the
correct entity works and that no automation references the orphan.

## Numeric air quality

CO₂ and particulate measurements are numeric source readings. They do not supply an overall
qualitative air-quality rating. The required Air Quality cluster remains Unknown; no new thresholds
are inferred. A controller may show both the working measurements and an unknown generic entity.
Selection details now explain the distinction. Entity presentation remains controller-specific.

## Matter.js test-controller structure race

A parallel Node 22 run of the 50-device addition test also exposed a Matter.js 0.17.9 client error:
`Cannot initialize ... because it is already active`, in `ClientStructure.#install`. Both
`ClientNodeInteraction.read` and its subscription callback feed `ClientStructure.mutate`, which
updates shared pending endpoint ownership. The read overlapped ongoing discovery reports.

The harness now uses the public `ClientInteraction` protocol API for explicit numeric reads on the
commissioned controller's authenticated peer exchange provider. Subscriptions still pass through
the ordinary client and maintain its endpoint tree. All descriptors, values, writes and commands
still cross Matter transport; reads do not synthesize attributes, retry away structural exceptions,
or mutate the same local tree a second time. This isolates protocol assertions from concurrent
client-cache installation. It is not a fix for that SDK cache race or evidence that another
controller cannot encounter it. The initial failing run and subsequent checks used synthetic devices.
