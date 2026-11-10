# Matter 0.15.6 storage fixture

`matter-0.15.6.json` contains synthetic disk storage generated with the pinned
dependencies and pairing test from commit `2594223`. All keys belong to disposable
test nodes. No real Homey data or external platform credentials are included.

The fixture was generated in an isolated Node 22 container by changing the test's
`makeNode` helper to use a fresh disk `StorageService.location` instead of memory.
After the second controller successfully commissioned the light and both controllers
controlled it, `FabricManager.persistFabrics()` was awaited on both controllers.
The restart subtest was omitted, and the existing cleanup hooks closed all nodes.
The `bridge`, `first`, and `second` directories were collected as a map of relative
filenames to their original UTF-8 contents. The failed controller was excluded.

The upgrade test copies the bridge files unchanged. For the test controllers it
retains their fabric keys and certificates, but rebuilds the cached client endpoints
using their original peer addresses with the current controller API. This tests
server storage compatibility and authenticated control with existing credentials;
it does not claim to test upgrading a controller application's endpoint cache.

## Previous bridge release mapping storage

`mapping-upgrade.json` contains synthetic bridge and controller storage written by bridge revision
`d340d3eb932feb81b0d03423cc4383ffdbdbeaf2` with Matter.js 0.17.9. The local maintenance script
`node tests/mappings/generate-upgrade-fixture.mjs` reads that revision's actual server implementation
from Git, runs it with the synthetic mapping devices, commissions a disposable controller, and
persists source updates before shutdown. Public CI reads the saved fixture and needs no Git history.

The fixture records its full source revision, endpoint numbers, peer address, and original storage
file contents. Its keys and certificates belong exclusively to disposable test nodes. It contains
no real Homey state or external controller credentials. The generator excludes the controller's
cached endpoint descriptions, retaining its fabric credentials. Tests reconnect with these existing
credentials and rediscover endpoints; they do not model Google Home's own cached device descriptions.

Upgrade assertions change Homey values while the bridge is offline, then check controller values,
subscriptions, commands, and retained endpoint numbers. Sensor endpoints newly exposed on mixed
capability devices may be added; the original endpoint numbers must remain unchanged.


## Matter 0.17.9 retained groups, scenes and controller cache

`matter-0179-retained.json` was written by the unchanged bridge at
`b4f2d1406bd03bb5fa7a6c1c23cbc9a096312a02`, running its pinned Matter.js 0.17.9 under
Node 22.20.0. It contains only synthetic test nodes. Unlike the earlier mapping fixture, it
includes the controller's persisted endpoint cache as well as its credentials. It records
parent/child endpoint numbers and device types for a socket, extended-color light, lock,
smoke alarm and battery water sensor. The light belongs to group 31 and has scene 7 stored.

To reproduce, archive that revision into a disposable directory, run `npm ci` there, copy
`tests/mappings/generate-matter18-fixture.mjs` from the upgraded checkout to the same relative
path in the archive, and run it with Node 22. Copy the resulting fixture back only after
reviewing its provenance. The generator refuses any SDK other than 0.17.9.

The upgrade test restores these files unchanged, reconnects with the original controller
credentials and cache, verifies all original identities, reads the retained group, recalls
the saved scene, and controls the same light after a further restart. It also asserts that
upgrading alone does not write any Homey capabilities. Physical ecosystem caches and UIs
remain covered by the separate release checks rather than this synthetic controller.
