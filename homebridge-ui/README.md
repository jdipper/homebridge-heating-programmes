# Shared programme editor

The editor presents FastWarm and Hive rooms together. Home, Away and Holiday are
saved weekly temperature programmes; the selected editing tab is independent of
the active household programme. Loading from a thermostat copies its fresh,
complete programme into the selected draft and never changes the heating.

Use the system filter and room checkboxes to choose the scope. The shared editor
copies one programme into separate room drafts. Every selected room's period and
temperature limits are checked before any shared draft is saved. FastWarm needs
four periods per day; Hive supports one to six, including different counts on
different days. Adding a period creates blank fields and never invents a time.

Saving and applying are separate actions. Applying first requests a preview, then
consumes it once. Read-only connections can load, edit, save and verify drafts;
they cannot apply or enroll in automatic changes. Each room has its own result,
because updates across systems cannot be atomic. A missing device connection is
shown even if it cannot currently list its rooms. Uncertain outcomes are never
automatically retried by the editor.

The custom UI server uses Homebridge's UI SDK and an owner-only local Unix socket.
It accepts only the shared household/editor routes. It reads the single
`persist/HeatingProgrammesRuntime.json` descriptor, validates its identity, owner,
permissions, socket location and live process, then forwards its private bearer
token only to that socket. Tokens and device credentials never reach the browser.
Replies must identify the same controller instance. Request/reply sizes and waits
are bounded; a timeout does not automatically repeat a request.

The browser assets are independent of the runtime implementation. Offline checks:

```sh
node --check homebridge-ui/server.js
node --check homebridge-ui/public/schedule.js
node --test test/editor*.test.cjs
```

The proxy tests use simulated local controllers and require permission to create
local Unix sockets. They do not contact Hive, Tuya or heating equipment.
