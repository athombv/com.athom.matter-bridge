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
