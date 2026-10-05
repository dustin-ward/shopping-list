# Implementation plan and agent handoff

## Working agreement

- This repository began with plans only; implementation status is recorded below.
- Read `README.md`, `docs/product.md`, and `docs/architecture.md` before coding.
- Implement only the agreed MVP. Future interests are not authorization to build
  those features, accounts, offline edits, or a public deployment.
- Follow a single-package SvelteKit/TypeScript architecture with server-only
  database/services and a small mobile UI.
- If a recommended implementation detail is incompatible with the chosen
  supported framework version, adjust the mechanism, preserve product behavior,
  and document the decision.
- Do not silently weaken history, transaction, conflict, offline-read-only, or
  network-security requirements to simplify implementation.
- Track progress against the milestones below and report tests actually run.
  Do not claim tests, Proxmox deployment, or real-phone checks that were not done.

## Implementation status — 2026-10-04

- **Milestone 0:** Scaffold, pinned dependencies/lockfile, validated configuration,
  schema/migration/bootstrap, health endpoint, production adapter, shell, and
  Compose/Docker files are in place. Local install, checks, migrations, build,
  and adapter startup were verified. The Docker build/container gate remains
  unverified because Docker is unavailable in the implementation environment.
- **Milestone 1:** Online entry/group flows, immutable purchase history, undo,
  cancel, targeted clear, cursor history, mobile UI, and revision-checked
  transactions are implemented and covered by temporary-SQLite tests plus a
  production-mode browser shopping cycle.
- **Milestone 2:** ETag polling, three-second visible-page refresh, conflict
  handling, server-instance tokens, revision floors, and restore-aware snapshot
  acceptance are implemented. Two-context polling and stale-response behavior
  have automated coverage.
- **Milestone 3:** Manifest, icons, versioned shell/static caches, IndexedDB
  snapshot, offline read-only mode, reconnect refresh, cache clearing, and
  draft-safe update prompting are implemented. Chromium production tests cover
  offline reload and reconnect; physical phones remain untested.
- **Milestone 4:** Private loopback Compose topology, host/origin checks,
  operations/restore instructions, and an online SQLite backup command with
  integrity checks are implemented. Backup/restore has a disposable-database
  integration test. Docker/LXC, tailnet ACL/Serve, and physical-device deployment
  gates remain unverified.

## Milestone 0 — foundation and deployment spike

Deliver:

- Scaffold supported SvelteKit/Svelte/TypeScript releases with `adapter-node`.
- Add pnpm lockfile, lint/format/type-check commands, Vitest, and Playwright.
- Configure validated runtime settings, server-only DB access, and health check.
- Add schema, reviewed migrations, and idempotent shared-list bootstrap.
- Verify a minimal production Docker build with SQLite on a persistent volume.
- Establish the shell-loading approach needed for later offline navigation.
- Add `.env.example` and ignore local data, backups, secrets, and generated output.

Gate: fresh install, checks, migration, production build, and container startup
work. Restarting/replacing the container retains a seed record. Native SQLite
dependencies load in the chosen image architecture.

## Milestone 1 — complete online vertical slice

Implement domain transactions and routes together with a usable mobile screen:

- Create/name/reorder/archive groups; distinguish stores from categories.
- Add entries with arbitrary names, quantity, note, and multiple groups.
- Reuse catalog identity and remembered group defaults.
- Edit/cancel active entries; show All items, group views, and Ungrouped.
- Purchase, retain completed entries, undo, and targeted clear/archive.
- Record immutable purchase snapshots and expose paginated history.
- Add validation, duplicate prevention, consistent errors, and revision checks
  from the first mutation implementation—not as a later retrofit.

Gate: one browser completes a full shopping cycle. Multi-group completion and
undo work; clear preserves history; cancellation creates no purchase. Refreshing
the page reproduces the correct state from the database.

## Milestone 2 — collaboration and recovery

Deliver:

- Consistent snapshot endpoint, ETag polling, and global revision tracking.
- Foreground polling, resume refresh, and post-mutation refresh.
- Same-entry/group conflict UI with retained drafts and explicit retries.
- Pending-state controls and ambiguous-save messaging; no automatic mutation
  replay after transport failure.
- Out-of-order snapshot handling, server-instance preconditions on mutations,
  and recovery after database restore.
- Connection state based on requests; bounded retry/backoff and manual refresh.

Gate: two independent browser contexts can shop together. Concurrent writes to
different entries both survive; same-entry conflicts are visible. A simultaneous
purchase records exactly one valid purchase. Delayed responses cannot roll the
visible state backward or permanently reject a restored database.

## Milestone 3 — mobile PWA and offline viewing

Deliver:

- Manifest, appropriate icons, cached bootable shell, and versioned asset caches.
- IndexedDB last-known snapshot with schema version and verification time.
- Read-only offline group filtering/details/Purchased section.
- Clear offline banner, first-offline-launch state, and storage-failure handling.
- Reconnection refresh before edits resume; local-cache clearing action.
- Accessible touch controls and keyboard/screen-reader-friendly essential flows.

Gate: after an online visit, offline reload/navigation opens the cached list,
not a browser network error. All server-mutating controls are disabled; no
requests are queued for later. Changing server data while the phone is offline
is reflected after reconnect. Verify service worker behavior against a production
build, not only the dev server.

## Milestone 4 — operational readiness and final handoff

Deliver:

- Non-root production image, persistent data ownership, health check, graceful
  shutdown, documented configuration, and private Compose port binding.
- Trusted host/origin enforcement and tests for cross-origin rejection.
- `docs/operations.md`: tailnet HTTPS topology, LXC assumptions, installation,
  troubleshooting, upgrades, backup scheduling, retention, and restore.
- Safe backup command, integrity check, off-host-copy guidance, and a tested
  restoration procedure.
- README updated with actual commands, prerequisites, screenshots if useful,
  and known limitations. Preserve links to the original product/design documents.

Gate: a clean environment can follow the documented Compose setup without source
edits. Container replacement preserves data. Restore into a disposable data
directory reproduces historical and current state. Confirm the service is not
reachable through unintended public/LAN paths for the selected topology.

## Required tests

### Unit/domain

- Name normalization, limits, empty input, and no accidental synonym merging.
- Store versus category attribution.
- Effective Ungrouped membership after group archival.
- Purchase and cancellation state rules.
- Polling visibility/resume behavior and snapshot freshness logic.

### Database/integration (real temporary SQLite databases)

- Fresh migration/bootstrap and migration from an earlier committed schema.
- Name resolution/default groups; no silent duplicate active entries.
- Multi-group assignment and archival without damaging historical references.
- Atomic purchase plus history; rollback leaves neither half applied.
- Concurrent/stale edits, stale purchase after undo, and active-duplicate undo.
- Undo voids history; a later completion produces a new valid purchase.
- Clear archives only submitted IDs; conflict aborts the entire batch.
- Historical item/store names survive entry rebinding and group renaming.
- Consistent snapshots, monotonic per-instance revisions, and ETag responses.
- Restart/restore changes the instance token; old-instance writes are rejected.
- Cross-list reference rejection and bounded/stable purchase pagination.
- Database backup/integrity check and restored data equivalence.

### End-to-end (production-mode build)

- Add/edit/purchase/undo/clear on narrow iOS/Android-sized viewports.
- Same entry appears in both stores and completes globally with the correct
  actual store.
- Two browser contexts edit different entries and conflict on the same entry.
- Concurrent check-offs create exactly one valid purchase.
- A newer purchase is not cleared by another device's older Purchased snapshot.
- Lost add/purchase responses do not duplicate data or silently imply success.
- Delayed polls cannot replace newer confirmed state.
- Offline reload, group switching, and read-only control enforcement.
- Tailnet/server unreachable despite browser being "online."
- Reconnect refresh, first visit offline, storage failure, cache schema change,
  and local data clearing.
- Service-worker update does not silently discard a form draft.
- Database restore/restart refreshes a formerly higher-revision cached client.
- Cross-origin JSON mutations and unexpected Host requests are rejected.

### Manual deployment/device checks

- Real iOS Safari and Android Chrome: viewport, keyboard, touch controls,
  home-screen installation, offline reopen, and reconnection over tailnet.
- Actual Proxmox LXC: Docker support, bind-mount ownership, disk persistence,
  tailnet routing, HTTPS, firewall/port scope, and backup restore.
- Record untested devices/topologies explicitly if they are unavailable.

## Suggested quality commands to provide

The implementation should define scripts for type checks, linting, unit and
integration tests, production build, production-mode end-to-end tests, migrations,
and backup. Document the actual commands rather than leaving guessed commands
in the finished README.

CI, if added, should run deterministic checks/build/tests without access to the
real home-lab database or tailnet. Initialize disposable test databases only.

## Scope and complexity checkpoints

Before adding complexity, ask whether a simpler MVP mechanism satisfies the
requirement:

- Polling before WebSockets.
- One app service before workers/queues.
- Text quantity before unit systems.
- Online-only writes before offline reconciliation.
- Purchase rows before event sourcing.
- Explicit future migrations before speculative product/receipt tables.

The expected outcome is a reliable household utility, not a grocery-commerce
platform. Ship and validate the complete MVP before beginning optional features.

## First implementation-agent prompt

> Implement the shopping-list MVP described in this repository. Read README.md,
> docs/product.md, docs/architecture.md, and this implementation plan first.
> Work in milestone order, starting with the foundation and a verified Docker/
> SQLite deployment spike. Preserve multi-group single-entry semantics, atomic
> purchase history, revision-based conflict detection, read-only offline viewing,
> and tailnet-only access. Do not implement features marked deferred. Add tests
> alongside behavior, update operational documentation, and report completed
> milestones, checks run, and any remaining device/deployment verification.
