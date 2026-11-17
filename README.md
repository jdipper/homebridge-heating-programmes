# Heating Programmes

One Homebridge editor and household controller for FastWarm and Hive. The vendor
plugins retain account sign-in, normal device accessories, and native device
operations. This plugin owns saved Home/Away/Holiday programmes, household
presence, guest hold, Holiday return/preheat, history, and one Heating
accessory containing independent Home and Holiday switches in Apple Home.

This local development build is **0.1.0-jdipper.8**. It is not an npm publication.
Install it together with the Tuya device-provider build **2.7.3-jdipper.7** and the
scoped Hive provider **`@jdipper/homebridge-hivehome-control` 1.1.0-jdipper.4**.
The existing unscoped Hive provider build **1.1.0-jdipper.2** remains compatible
while an installation moves to the scoped package. Do not run the old Tuya household controller
alongside it; startup checks and an exclusive private owner lock prevent two
controllers from managing the same household.

## Using the editor

Open **Heating Programmes** in Homebridge. Rooms identify their FastWarm or Hive
system; filter the list or select rooms across both systems. Choose the profile
to edit, then **Load stored programmes** to copy each thermostat's complete native
week into its own draft. Importing and saving never change heating. No Home,
Away or Holiday programme is invented for a new room.

FastWarm requires exactly four periods per day. Hive preserves one to six periods
and its actual first event time. A bulk draft is checked against every selected
room's capabilities before any copies are changed. Use **Review & apply** for a
manual change. Every system is uploaded and verified separately; one room can
succeed while another needs attention. Uncertain results are not retried.

Save all three profiles before enabling automatic household changes for a room.
Hive is initially read-only until uploads and that specific zone are deliberately
enabled in its provider plugin. Configured Hive limits are validation bounds,
not remote changes to the thermostat. Native Hive Holiday and Heat on Demand
controls are never modified by this editor.

## Apple Home

Open the **Heating** accessory to access both switches. They are published as two
ordinary Switch services on the same accessory, matching Hive's Manual/Boost
controls. Apple Home controls their exact presentation. Their configured names
are **Heating Home** and **Heating Holiday**; each switch remains independent.

| Switch | On | Off |
| --- | --- | --- |
| Heating Home | End Holiday, clear its return/preheat deadline and select Home | Remember everyone is away; select Away immediately unless Holiday or a guest hold takes priority |
| Heating Holiday | Holiday profile takes priority | Resume the remembered Home/Away selection |

Holiday on shows Home off while preserving household occupancy separately.
Home off during Holiday records absence without cancelling Holiday. Ending
Holiday requires known occupancy or an active guest hold; unknown occupancy is
never treated as Away. Editor buttons labelled **Someone home** and **Everyone
away** record occupancy through `/presence` and keep Holiday active. Apple Home's
Home switch uses the explicit `/home` selection, which ends Holiday when turned on.

The same selection applies to enrolled rooms in both systems. Configure Apple
Home's first-person-arrives and last-person-leaves automations on the shared
Home switch inside Heating. Holiday return time and optional preheat lead are edited
in Homebridge. These deadlines require Homebridge and the provider's internet
connection. Device execution of the uploaded week during an outage, clock
retention, and radiator-valve writes still need their own hardware validation.

Homebridge no longer delays a departure. If an Apple Home automation or shortcut
adds a delay, an arrival must invalidate that pending departure before selecting
Home. A sleeping shortcut that later sends Home off can otherwise override the
arrival. Overlapping departures need a restartable helper or a per-run identifier;
this plugin does not create an external helper or shortcut.

## Migration and storage

On first startup, legacy `TuyaThermostatProfiles.<instanceId>.json` files are read
without being modified. Complete profiles, room names, time zones, accepted
history, enrolment and household rules migrate to owner-only
`persist/HeatingProgrammes.json`. Source names and hashes are retained. Later
starts use the shared file and do not re-import stale legacy settings.

Startup and reconnect do not send programme changes. Cached confirmations are
not trusted as fresh hardware evidence. Interrupted uploads, active legacy
overrides, overdue deadlines, conflicting household settings, or an unknown
outcome require review. The grouped Heating accessory replaces the earlier
separate shared Home and Holiday accessories using a new stable identity.
Any Apple Home automations using those old controls need their switch selected
again. Cached grouped controls and custom switch names survive later restarts.
Existing thermostat accessories remain with their vendor plugins.

The `.8` transition update preserves that grouped identity and both service
subtypes. Saved Away-delay settings and countdowns are discarded on restore.
The restored household selection is shown without uploading a programme at
startup; an explicit new selection applies the latest saved week. Guest holds
and Holiday return/preheat deadlines retain their existing recovery checks.

For the historical native-boundary investigation, the shared controller
also provides a private **read-only** compatibility connection using the old Tuya
device IDs. It supports reading native programmes only, publishes no switches,
and cannot select a profile or change heating. The dated test's read-only
discovery path uses that private directory. Its frozen dates, times, commands
and evidence are not changed or rescheduled.

Both private connections and the editor proxy use bounded, authenticated Unix
sockets in the owner-only `heating-runtime` directory beside `persist`. Regular
JSON descriptors remain in `persist`; no socket is placed in Homebridge's scanned
storage directory. Credentials and socket tokens are
never sent to the browser. The editor opens no additional LAN listener.

## Provider foundation

## Current capabilities

- Read measured room temperature, target temperature, mode, online state and the
  complete native week for Hive heating zones and radiator valves.
- Represent each room's Home, Away and Holiday drafts as temperature periods in
  a complete seven-day week. These profile names do not enable Hive's built-in
  Holiday mode.
- Preserve one to six periods per day and the first native period's actual time.
  Importing a programme never invents a midnight event.
- Prepare a change against a fresh baseline, then apply that preview once with
  another baseline check and one schedule-only upload.
- Verify every period, Scheduled mode, online state and unchanged Holiday/demand
  settings. Acknowledged uploads receive up to three read-only verification
  attempts. Uploads are never automatically retried.

The transport uses the running Hive plugin's authenticated private Unix socket.
Hive credentials stay with that plugin. Hot water products are excluded from
this provider's programme controls.

Private Hive runtime descriptors accept only the exact package names
`@jdipper/homebridge-hivehome-control` and `homebridge-hivehome-control`. The latter
supports migration from the earlier local provider; the upstream npm release
does not supply this programme connection. Both identities require the same
owner-only directory, descriptor and socket, live process, instance ID, token,
capability and response checks. Renaming the provider does not change the shared
controller's Apple Home accessories, child bridge identity or saved programmes.

Every private write command carries the desired week, the preview's absolute
expiry time and exact baseline preconditions. Preconditions include the normalized
old week, mode, target, native Holiday and demand settings, plus all heating-zone
Holiday records sorted by binary product ID. Missing metadata is represented as
JSON `null`; copied metadata is immutable.

The IPC transport forwards the expiry only in the private
`x-hive-programmes-expires-at` header. The Hive runtime and Python connection check
the deadline and compare those preconditions again after their own queue/lock and
final fresh read. A changed baseline or expired preview stops before the cloud
write. The Hive cloud request body remains exactly `{"schedule": completeWeek}`;
private preconditions and expiry are never included in it. The adapter, IPC client
and Hive runtime must implement this same precondition/expiry contract.

## Programme format

Each weekday contains strictly increasing minute-of-day times and Celsius targets:

```ts
{
  monday: [
    {startMinute: 300, targetC: 18.5},
    {startMinute: 420, targetC: 7},
    {startMinute: 990, targetC: 18.5},
    {startMinute: 1290, targetC: 7},
  ],
  // tuesday through sunday are also required.
}
```

Times refer to the device's local weekly schedule. This codec does not infer a
time zone, adjust the device clock or verify its clock retention.

Hive may pad an upload response to six slots by repeating the final event. The
parser removes only exact, consecutive copies of that final event. Conflicting
events at the same time, internal duplicates, incomplete days and unknown native
event fields are rejected instead of silently altered.

## Adapter use

`HiveProgrammeAdapter` accepts an injected transport. Model target limits must be
supplied explicitly and must agree with the running Hive provider's validation.

```ts
const adapter = new HiveProgrammeAdapter(transport, {
  targetLimits: {minC: 5, maxC: 32, stepC: 0.5},
});

const zones = await adapter.readZones();
const preview = await adapter.prepare(zones[0].id, savedHomeDraft);

// Present the preview for review before this explicit apply action.
const result = await adapter.apply(preview.token);
```

Previews expire after five minutes by default and are consumed by the first apply
attempt. A changed native programme, target, mode, Holiday state or demand setting
blocks a stale preview. An already matching programme is confirmed by a fresh read
without a redundant upload.

Writes require the zone to be online and in Scheduled mode. Native Hive Holiday
must be inactive. Until heating-to-valve links are explicitly modelled, active or
unknown native Holiday metadata on any Hive heating zone blocks this provider's
programme writes. No operation clears Holiday, sets a separate target, changes
mode or changes Heat on Demand settings.

`apply` distinguishes confirmation, a baseline conflict, a request known not to
have been sent, an acknowledged but unverified result, and an unknown write
outcome. A timeout remains unknown even if a later read happens to match. A new
read and explicit review are required before considering another upload.

## Programme request counts

An automatic change keeps the fresh native week reserved in one device queue
while the controller rechecks the saved draft and records its pending operation.
Application uses that exact one-shot baseline, with fresh controls before upload
and complete week/control verification afterward. Manual reviewed previews keep
their independent baseline checks. Reservations expire or are discarded without
writing if a draft changes.

The paired Tuya provider retains the six-room group, grouped inquiry/write
support and validated capability cache. For six changed rooms with one packet
per room and grouped inquiries, the expected Home path needs 23 Tuya HTTP attempts with a
cold capability cache or 22 with a warm one. One identical Away packet shared by
all six is expected to need 19 cold or 18 warm. These normal paths have offline
request-count regressions. A complete no-change check was measured live at nine
cold and eight warm. Membership, online state, native mode and individual complete
readbacks remain fresh checks; hardware confirmation is never inferred from one
group acknowledgement. Authentication, retries and unrelated polling are extra.

With the paired `.7` Tuya provider, superseding an automatic request sends a
private local cancellation message, not a cloud request. Unsent commands stop at
command/dispatch boundaries; a submitted command finishes before the latest
different profile obtains a fresh baseline. Failed identical selections are not
automatically replayed. A stopped upload can leave a mixed native week, so an
obsolete result never confirms the newer selection. Older `.6` providers finish
their current upload before the shared controller applies the latest selection;
they do not advertise per-command cancellation.

The existing unchanged Hive week adds two Hive requests. Hive traffic uses its
own service and is separate from the Tuya allowance. A submitted Hive week is one
command and finishes before the next selection; an unsent superseded preview is
discarded without another cloud read or upload.

Automatic household changes prepare one fresh native baseline in the provider;
the controller does not request the same baseline separately. FastWarm providers
must explicitly prove that preparation required Scheduled mode. An older provider
that ignores this requirement is refused before applying the programme, preserving
manual Hold and boost settings during a coordinated upgrade.

With the scoped Hive provider `1.1.0-jdipper.4` or later, an ordinary changed-week
application uses three cloud reads and one schedule upload: preparation, the
runtime's fresh pre-write guard, and the final complete-week readback. The private
runtime advertises `freshWritePreconditions`; the client checks that capability
again at dispatch and the runtime rejects a guarded request if its backend cannot
provide the guard. The Python comparison of schedule, target, mode, Holiday and
demand settings remains in place immediately before the upload.

Older Hive runtimes keep the extra client pre-write read, for five requests in the
normal changed-week path. A week already on the thermostat uses two fresh reads
and no upload. Verification can make up to two additional read-only attempts;
unknown writes are never replayed or confirmed solely from a matching readback.
Local IPC and descriptor checks do not contact either cloud service. Authentication
refresh and unrelated background polling are additional to these counts.

The **Tuya API usage** section reads private local counters without contacting
Tuya. It includes observed authentication, push-connection renewal, retries and
other runtime requests. The displayed start time makes a partial first month
explicit; earlier requests and other apps are excluded. Native daily temperature
periods run on the thermostat and make no requests from this controller. Its
minute-by-minute Tuya status refresh reads the local provider cache only.

## Development

The package remains private and unpublished. The Homebridge entry point is
`dist/plugin.js`; the lower-level adapter exports remain at `dist/index.js`.
Development requires Node 22 or later:

```sh
npm install
npm test
```

The adapter tests use simulated transports and do not access Hive accounts or
heating hardware. Live unchanged-week and Away-to-Home tests on 8 November 2026
verified the Hive thermostat's complete 28-period week and its active target after
each changed programme. Radiator-valve writes and offline execution remain separate
hardware checks.
