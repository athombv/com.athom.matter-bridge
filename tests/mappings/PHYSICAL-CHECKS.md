# Physical release checks

Use devices you already own. Start with Google Home; additional controller platforms are optional.
Mark unavailable device families **not physically tested**. Synthetic tests still exercise their
mapping contracts. Keep completed inventories, screenshots, real device names, addresses and logs
under the ignored `tests/mappings/artifacts/` directory, not in this public template.

## Record once per candidate

- Candidate commit, app version, controller app version and test date.
- Confirm the candidate app is installed on the Homey that actually shares the device.
- Preserve the existing pairing. Record whether the controller needed to be reopened or refreshed.
- Record each check as pass, fail, or not physically tested; include the actual observed behavior.

## Checks for available devices

| Available device | Checks |
| --- | --- |
| Any shared device | Existing device remains available after update; no duplicate or lost pairing. Change it in Homey, then confirm the controller updates. Change it in the controller, then confirm Homey and the physical device agree. |
| Color/temperature light | Start in temperature mode; Google shows a white temperature. Switch to a color and back through both apps. Check brightness while on and off, plus on/off. Reopen Google Home and verify the displayed mode and color. |
| Other lights | On/off, low and full brightness where supported, warm/cool limits where supported. |
| Socket | On/off from both apps; power display follows a safely observed load change where supported. |
| Thermostat | Supported modes only; fractional setpoints; separate cooling target where supported. Use safe operating values appropriate to the installation. |
| Cover | Open, close, position where supported; stop only if the source exposes it. Confirm direction and displayed position. |
| Lock | Observe an existing state change and confirm polarity. Exercise commands only when convenient and safe for the person present. |
| Sensors | Compare displayed values and units with Homey; observe a normal change. Do not deliberately create smoke, gas, or other hazardous conditions. |

## Restart and selection checks

For an available light or socket, retain the controller pairing and check after app restart. Where
practical, change the device while the bridge app is stopped and verify its current value appears
after startup. Disable and re-enable sharing for a test device and confirm updates work afterward.
Record controller rediscovery behavior, particularly for devices gaining sensor endpoints.

## Release decision

Review the automated report, documented advertised-command gaps, and these physical results together.
Do not turn a missing physical test into a pass. A successful single-device check provides evidence
for that device, controller and scenario only.
