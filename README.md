# PingRoom room blueprint

Keep an existing private room’s quick-action labels and icons in a small JSON file. Preview the changes, then apply the saved plan by its exact hash. Use it to configure consistent buttons for a project’s release or support workflow.

This starter manages existing slots 1–4 in a standard private room. It does not create or join rooms, rename them, change visibility, delete slots, press buttons, or send pings. You must own the room or be a room admin. **Use one writer at a time:** the API has no compare-and-swap protection against another editor changing actions during an update.

## Try it offline

Requires Node.js 22 or later. Use this GitHub template or clone it, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real pinned `@pingroom/sdk` 0.7.1 with a local mock transport. It previews a change, simulates a lost response after the server commits, and recovers by reading the result. It makes exactly one mocked update request, uses no credentials or network, and removes its temporary files. Installation needs npm access.

## Connect and review a plan

1. Install [PingRoom](https://pingroom.io/i) and select an existing standard private room where you are owner or admin.
2. Run `npm run connect`. Open the displayed pairing link and grant access to that room. Reuse this link while the invocation waits for approval.
3. Edit `blueprint.json`. Include only the slots whose labels and icons you want to manage.
4. Run `npm run plan` (also available as `npm start`). Review the room, before/after values, preserved settings, and `plan_hash`.
5. Apply that exact saved plan:

```sh
npm run apply -- YOUR_64_CHARACTER_PLAN_HASH
```

Apply uses the saved batch, not a newly edited manifest. Editing `blueprint.json` requires another plan and a new hash. A plan with no changes performs no update. Planning uses `rooms.list()` and `actions.list()`.

Pairing saves `.pingroom/credentials.json`, ignored by Git. Files use mode `0600` and directories `0700` on POSIX systems; keep these directories private on Windows too. To use a secret store or another granted room, supply **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Any defined environment pair overrides saved credentials; blank or partial overrides are rejected. Room codes are normalized to uppercase.

You can copy `.env.example` to `.env`; protect it with `chmod 600 .env` on POSIX. The scripts load it automatically; existing environment values take precedence. Do not commit credentials or state.

## Manifest and preservation

```json
{
  "actions": [
    { "action_number": 1, "label": "Ready to review", "icon": "👀" }
  ]
}
```

The manifest accepts 1–4 distinct existing slots numbered 1–4 and only those three fields. Labels must be nonempty printable ASCII, at most 80 characters. Icons may be emoji or supported icon IDs, at most 32 JavaScript string units. Neither field may contain control characters or begin or end with whitespace or server-trimmed invisible characters. Interior emoji joiners, such as in 👩‍💻, remain valid. These limits prevent server request trimming from changing the saved desired values. The same edge checks apply to saved and server baseline text; unsupported legacy values stop the run before any write. Empty labels/icons, new slots, and other configuration fields are rejected.

The server’s batch route resets omitted `sound` and `haptic_style` values to `null`, so this starter copies their current values into every changed slot’s request. It omits acknowledgement and required-input policies, preserving their stored values, and leaves unmanaged slots and unknown fields untouched. Legacy empty or whitespace-padded sound/haptic values are refused before writing; normalize those in the app first.

Free rooms support these first four slots. Pro rooms can contain more; this template leaves slots 5–16 untouched. Plan restrictions, current room grants, owner/admin permission, and any sound entitlement are enforced by PingRoom. A saved sound that is no longer permitted can cause the update to be rejected. Configuring buttons does not trigger them, although PingRoom sends its normal silent room-refresh update to devices.

## Drift and uncertain updates

The private `.blueprint/state.json` saves all accessible action IDs and known writable fields, the desired batch, connection/room binding, and plan hash. Apply reads the actions again and refuses any baseline drift before sending one transactional `actions.updateMany()` request. A final read checks the desired state, including unchanged slots and policies. These checks detect changes but cannot prevent a simultaneous editor from racing the write. Do not use this as an unattended reconciliation loop.

Before the update request, the journal is durably written as `applying`. A timeout, rejected request, lost response, failed verification read, or interruption leaves an unresolved attempt. It is never automatically retried, and another apply or plan is blocked. Run:

```sh
npm run recover
```

Recovery only reads the room and actions and records one result:

- `applied`: the saved desired configuration is currently visible. No update is resent.
- `baseline_observed`: the original baseline is currently visible. This observation does **not** prove an earlier request cannot still finish.
- `conflict`: the current configuration matches neither snapshot. Inspect it in the app; the starter does not roll back another editor’s work.

For the last two results, first confirm that the earlier request has stopped and review the room’s current state. Only then explicitly abandon the local attempt with `npm run discard -- YOUR_PLAN_HASH`. Discard makes no API request or room change; it permits a fresh plan with a new hash. Do not discard merely because time has passed. If the earlier request cannot be confirmed settled, keep the attempt blocked and investigate before writing again.

## Local operation and recovery

The state directory is bound to a hash of the credential and room code, plus the room UUID. A rotated credential or different room requires a separate `BLUEPRINT_STATE_DIR`; resolve any outstanding attempt before changing connections. Do not delete or edit the state file to bypass recovery. The latest plan replaces a resolved or abandoned plan; this is a recovery journal, not a permanent audit log.

Only one local command can hold the `.lock` directory. After a crash, inspect `.lock/owner.json` and confirm its process stopped before removing only that lock. An `applying` state still requires `recover`. Invalid, `null`, malformed, or altered state is rejected rather than reset. Restore it from your own backup if needed.

Local JSON files are limited to 128 KiB, read with a size bound, and replaced atomically after writing. Symlinked input files are refused. State contains action labels and settings; it is private, not encrypted. Atomic replacement is not a database or a guarantee against power loss. Use a private local filesystem, not a shared/network state directory.

The shipped SDK client uses five-second request timeouts. These APIs have no abort-signal parameter, so Ctrl-C stops after the current request settles; a ten-second watchdog may leave a lock after forced termination. After an interrupted write, recover before doing anything else. Exit codes: `0` for a finished plan/apply/discard, `2` for an unresolved outcome, `1` for other failures, `130`/`143` for SIGINT/SIGTERM.

## Adapt and test

Edit `blueprint.json` for another project’s button vocabulary. Import `runBlueprint` from `src/blueprint.js` to integrate the same explicit plan/apply flow into your own tooling; keep bounded SDK timeouts, exclusive state ownership, and human review of each plan hash.

`npm test` covers real SDK routes, exact batches, preservation, stale plans, lost responses, read-only recovery, cancellation, corrupted state, private credentials, and scope changes. CI runs tests and the offline demo on Node 22 and 24. Tests use a mock transport and do not verify a live account’s permissions or entitlements. See the [official SDK](https://github.com/pingroom/sdk).

To run local work when a teammate presses one of these buttons, use [starter-room-action-runner](https://github.com/pingroom/starter-room-action-runner). For local history export, use [starter-room-archive](https://github.com/pingroom/starter-room-archive).

MIT licensed.
