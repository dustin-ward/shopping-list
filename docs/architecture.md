# Architecture and project structure

## 1. Recommended stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| App | SvelteKit, TypeScript, `adapter-node` | One codebase and one runtime for UI/API |
| UI | Svelte components and a small shared CSS system | Mobile-first without a large design-system dependency |
| Database | SQLite, Drizzle, `better-sqlite3` | Local transactions, typed schema, versioned migrations |
| Validation | Zod | Shared request constraints; authoritative server validation |
| Offline | Web manifest, service worker, IndexedDB | Cached shell and explicit last-known read-only data |
| Tests | Vitest and Playwright | Domain/database tests and realistic two-browser scenarios |
| Tooling | pnpm, TypeScript checks, ESLint, Prettier | Reproducible builds and consistent code |
| Deployment | Multi-stage Docker build, Docker Compose | Matches existing home-lab operations |

Choose compatible stable releases and a supported Node LTS at implementation
time; record/pin them and commit `pnpm-lock.yaml`. Do not rely on unpinned `latest`
container tags in the deployment handoff.

One application process serves HTTP and owns a local SQLite database. Do not
add Redis, an external database, WebSockets, a scheduled worker, or a reverse
proxy container unless a concrete deployment requirement calls for it.

## 2. Request/data flow

```text
iOS / Android browser
  | HTTPS through existing tailnet access / Tailscale Serve
  v
SvelteKit application (one container)
  | route validation -> domain services -> transactions
  v
SQLite database on a persistent local volume

Browser only:
  service worker -> app shell / versioned static assets
  IndexedDB      -> last verified current-list snapshot
```

API routes are thin adapters. Business transitions, invariants, and transactions
belong in server-only services. Browser modules must not import database or
server-only configuration. Render user text as text, not trusted HTML.

## 3. Data model

Use UUID/text IDs and UTC timestamps consistently. Drizzle definitions and
generated SQL migrations are the source of truth. The tables below describe
intent, not a requirement to reproduce exact SQL column types.

| Table | Principal fields and relationships |
| --- | --- |
| `lists` | `id`, `name`, timestamps; bootstrap one shared list |
| `app_state` | Singleton monotonic `revision` for the current-list snapshot |
| `catalog_items` | `id`, `list_id`, `display_name`, `normalized_name`, timestamps |
| `groups` | `id`, `list_id`, `name`, `normalized_name`, `kind` (`store`/`category`), `position`, `revision`, `archived_at`, timestamps |
| `catalog_item_groups` | Default group memberships: `catalog_item_id`, `group_id` |
| `list_entries` | `id`, `list_id`, `catalog_item_id`, `name`, `quantity_text`, `note`, `status` (`active`/`purchased`/`cancelled`), `revision`, `completed_at`, `archived_at`, timestamps |
| `entry_groups` | This entry's group memberships: `entry_id`, `group_id` |
| `purchases` | `id`, `entry_id`, `catalog_item_id`, `name_snapshot`, `quantity_snapshot`, `note_snapshot`, `purchased_at`, nullable `store_group_id`, nullable `store_name_snapshot`, nullable `voided_at` |

Keep the catalog identity explicitly on a purchase: an undone active entry might
later be rebound to another catalog item, but old purchase identity must not
change. Snapshot fields preserve what the purchase meant at the time.

### Constraints and indexes

- Enable foreign keys on every connection.
- Unique catalog normalized name per list.
- Unique normalized group name among non-archived groups per list.
- Unique pairs in both membership tables.
- Partial unique index: at most one unarchived active entry per
  `(list_id, catalog_item_id)`.
- Partial unique index: at most one non-voided purchase per `entry_id`.
- Consistent state fields: active entries have no completion/archive timestamp;
  purchased entries have a completion timestamp and may be archived; cancelled
  entries are archived and have no completion timestamp.
- Index current entries by list/status/archive state, group membership by group,
  and purchases by item/time and overall purchase time.
- Verify list ownership of every referenced item, entry, and group in services.
  Cross-list references must be rejected even though only one list is exposed.

Do not add household/user tables or speculative product/receipt schemas yet.
The list IDs and stable item/purchase IDs give later migrations a useful anchor.

### SQLite operation

- Store the database at a configurable path, default `/data/shopping-list.sqlite`.
- Use WAL mode on local disk, foreign keys, a bounded busy timeout, and durable
  commits (`synchronous=FULL` is an appropriate small-household default).
- Keep write transactions short. Use atomic revision checks and transitions;
  do not do network I/O inside a database transaction.
- Read snapshot data and its global revision in one consistent read transaction.
- Mount the entire data directory so database/WAL/SHM files share persistent
  storage. Do not use a network filesystem for this SQLite deployment.
- Apply committed migrations before accepting traffic. Bootstrap the initial
  list idempotently. Never run development schema-push commands in production.
- Run one app replica; SQLite plus a local volume is not a multi-host design.

## 4. Domain transitions and concurrency

Each mutable entry/group has a revision. A mutation sends `expectedRevision`;
the transaction updates only if the current revision matches. Otherwise respond
with `409 CONFLICT` and enough information for the client to refetch/reconcile.
Do not use the global snapshot revision as a write precondition: editing another
entry should not invalidate a user's unrelated edit.

Generate a `serverInstanceId` UUID at process startup, include it in snapshots and
mutation responses, and incorporate it in ETags. Every mutation also carries the
instance ID from the client's last verified snapshot. Reject a mismatched instance
with `409 SERVER_CHANGED` before modifying data. This is a small safeguard against
old clients/requests after a restart or restored database whose revisions are lower
or happen to match earlier values. The token is not authentication.

Increment the entry/group revision on its mutations and the global revision once
per successful snapshot-affecting transaction. Group ordering is a bulk operation
guarded by the submitted revisions of all groups whose positions change.

Key transactions:

1. **Add:** resolve/create catalog item, check active uniqueness, create entry and
   memberships, save catalog group defaults, increment snapshot revision.
2. **Edit:** check entry revision, resolve a changed item name if needed, validate
   active uniqueness, update fields/memberships/defaults, increment revisions.
3. **Purchase:** check entry revision and active state, validate any actual store
   as a live store group, mark purchased, insert history snapshot, increment
   revisions. Do not infer stores from all group assignments.
4. **Undo:** check revision/state and active-item uniqueness, void the valid
   purchase, restore active status, increment revisions. Roll back on any failure.
5. **Cancel:** check revision/active state, mark cancelled and archived, increment
   revisions; never insert a purchase.
6. **Clear:** validate every explicitly targeted entry is purchased, unarchived,
   and at its expected revision; archive all targets atomically and increment
   revisions. Untargeted entries remain untouched.
7. **Group changes:** validate revisions, modify/soft-archive groups, and bump
   snapshot revision. Keep historical membership references. Snapshot reads
   exclude archived groups, so effective Ungrouped/defaults change accordingly.

For duplicate/concurrent purchase requests, the second request is a conflict
rather than another purchase. A network retry must not create side effects after
an intervening undo. Revision checks precede transitions; do not implement a
generic blind toggle or unconditional retry of stale requests.

Have the client supply a UUID as the new entry ID. Reusing that ID cannot insert
a second entry after an ambiguous add response. An existing ID returns a conflict
and requires refresh; it must not overwrite the original entry. No generic
idempotency subsystem or durable command queue is required for the MVP.

## 5. API contract sketch

All mutations are same-origin JSON requests validated on the server. These are
proposed endpoints; preserve the behavior if implementation naming differs.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/snapshot` | Shared list metadata, catalog names/default groups, live groups, active and unarchived purchased entries, snapshot revision and server instance ID |
| `POST /api/entries` | Add with client ID, name, optional quantity/note, group IDs |
| `PATCH /api/entries/:id` | Edit with `expectedRevision` and editable fields |
| `POST /api/entries/:id/purchase` | Complete with `expectedRevision`, optional actual store ID |
| `POST /api/entries/:id/undo` | Restore active with `expectedRevision` |
| `POST /api/entries/:id/cancel` | Remove active entry with `expectedRevision` |
| `POST /api/entries/archive` | Clear explicit `{id, expectedRevision}` purchased targets |
| `POST /api/groups` | Create name/kind |
| `PATCH /api/groups/:id` | Rename with `expectedRevision` |
| `POST /api/groups/:id/archive` | Soft-archive with `expectedRevision` |
| `POST /api/groups/reorder` | Atomic positions with affected group revisions |
| `GET /api/purchases?cursor=...` | Bounded cursor-paginated valid purchase history |
| `GET /healthz` | Minimal health/readiness result after migrations and DB query |

Use consistent error envelopes with a code, user-readable message, and optional
field errors. Distinguish `400` malformed input, `404` missing resource, `409`
conflict/duplicate, and `500` unexpected server failure. Log diagnostic details
server-side rather than returning database paths or stack traces.

`GET /api/snapshot` returns an ETag derived from its server instance and global
revision and supports `If-None-Match`/`304`. API responses must not be stored by
intermediary/browser HTTP caches; the application explicitly stores the offline
snapshot. Use `Cache-Control: no-store` and keep ETag polling metadata in the app.

The snapshot includes all data required to render the current list offline, but
not unbounded historical purchases. Store an explicit snapshot schema version.
The history endpoint uses a stable `(purchased_at, id)` cursor, not an offset that
shifts under concurrent inserts.

## 6. Client synchronization

- One snapshot store contains confirmed server state.
- Keep drafts and in-flight operations separate from confirmed data.
- Poll every three seconds while visible. Avoid overlapping requests; immediately
  refresh on resume/focus and after a successful mutation.
- Within one server instance, ignore older snapshot revisions arriving after
  newer results. A mutation returns its committed global revision; reject
  snapshots below that revision.
- Make freshness apply to server state, not just receipt of an HTTP response. If
  an out-of-order/stale snapshot is discarded, do not mark the view revalidated.
- Coordinate mutation/refetch requests so the client is not briefly allowed to
  write from an obsolete revision after its own save.
- A `304` revalidates the currently associated ETag/snapshot and advances the
  last-verified timestamp. Never associate a `304` with a different snapshot.
- A database restore may lower revisions. A new server instance invalidates old
  revision floors/ETags: fetch and accept its authoritative snapshot, replace
  the cached copy, and only then enable writes. Track retired instance IDs for
  the current browser session so delayed responses from an old process cannot
  roll the state back again. On startup/full reconnect, fetch unconditionally.
  Never permanently reject restored data because an earlier revision was higher.
- On a conflict, refresh and keep the user's draft for comparison/retry. Never
  automatically resubmit it against a new revision.
- On transport failures, back off repeated requests modestly (up to about 30
  seconds); resume immediately on visibility/online events or manual Refresh.
- Provide a short retry action and a visible unavailable/stale state. A
  successful current snapshot/readiness recovery is required before re-enabling
  mutations after a connectivity failure.

Polling is intentionally the first implementation. SSE/WebSockets are optional
later optimizations, not prerequisites for reliable collaboration.

## 7. PWA and offline cache

The UI shell must boot without a live server-rendered database query. Use a
client-loaded snapshot and a prerendered/cacheable shell route with
`adapter-node` handling the API. Keep the shell routing simple (for example,
client view state under one `/` route) and verify the offline build behavior.

Service worker responsibilities:

- Precache only the same-origin shell, manifest/icons, and versioned static
  assets needed to start the UI. Support offline navigation to the shell.
- Do not cache mutation responses or make API calls appear successful offline.
- API data is not service-worker cached; IndexedDB is the one explicit snapshot
  source. Never queue POST/PATCH requests or use background sync for writes.
- Version caches, remove obsolete versions safely, and offer a reload for an
  available update without discarding an open draft.
- Clearing local data clears the snapshot and app caches. Explain that offline
  reopening requires another successful online visit afterward.

IndexedDB stores the last successfully fetched/revalidated snapshot and
`lastVerifiedAt` atomically. Cache failures/quota errors must not break online
shopping; show a warning that offline viewing is unavailable. Handle incompatible
cached schemas by discarding the snapshot and asking for an online refresh.

At startup, show a cached snapshot as stale/read-only until the server verifies
it. First startup without cached data shows a connection-required state. Browser
`online`/`offline` events are hints, not authoritative connectivity checks.

Use HTTPS at a stable tailnet hostname: service workers require a secure context
(except localhost development). Test actual iOS Safari and Android Chrome as well
as emulated mobile browsers. Home-screen installation is useful but not required
to use the app in a browser tab.

## 8. Security and deployment boundary

There is **no app authentication**. Anyone who can reach the service has full
household access. Tailnet ACLs/grants and host/container network restrictions
therefore are the access-control system, not optional hardening.

- Prefer an existing tailnet HTTPS proxy or Tailscale Serve forwarding to an
  app port bound only to host loopback. Serve on the host can forward to the
  host's loopback-published container port.
- Alternatively bind a verified tailnet interface/address and enforce firewall
  rules. Document the exact topology selected for the user's LXC.
- Do not publish an unrestricted `0.0.0.0` host port or assume that tailnet use
  makes a separately reachable LAN/public port private.
- Tailscale Funnel/public ingress is out of scope and must not be enabled.
- Configure the canonical public origin/allowed host explicitly. Protect all
  unsafe JSON routes with an Origin check, require appropriate JSON content
  types, keep CORS disabled, and retain SvelteKit's form CSRF protections. JSON
  route protections must not be assumed to be supplied by form-action defaults.
- Reject unexpected Host headers and trust proxy forwarding headers only from
  the configured proxy/topology; do not blindly accept arbitrary forwarded hosts.
- Tailnet-only does not eliminate CSRF/DNS-rebinding risks from malicious pages
  viewed on an authorized phone. Test cross-origin mutation rejection.
- No third-party fonts/analytics or secrets in browser code. Avoid logging item
  notes or full request bodies unnecessarily.

Docker requirements:

- Multi-stage build; production dependencies only; run the application as a
  non-root user. Account for `better-sqlite3` native binaries in the target build
  architecture and runtime distribution (a Node LTS Debian slim base is a useful
  default).
- Compose exposes only the app's intended private port, mounts `/data`, sets
  required origin/database configuration, declares health checks, and uses a
  restart policy such as `unless-stopped`.
- Explicitly document persistent directory ownership/UID/GID. Bind-mount
  permissions in an unprivileged LXC can differ from the Proxmox host's IDs.
- Handle SIGTERM and stop accepting requests before closing the database.
- Verify Docker support/nesting and storage for the existing LXC setup; do not
  prescribe making the LXC privileged or disabling isolation as a shortcut.
- No automatic application-version updater or unattended major migrations.
  Back up before upgrades and document incompatible rollback restrictions.

Provide `.env.example` without secrets, startup errors for missing/invalid config,
and readable logs. Suggested settings: database path, canonical origin, app port,
and log level. Explain which settings are adapter-specific versus app-specific.

## 9. Backup and restore

Provide an operational backup script using SQLite's online backup API, or a
carefully documented stopped-app backup. Never recommend copying just a live
`.sqlite` file while WAL writes may be pending.

- The backup captures entries, groups, catalog/defaults, valid and voided
  purchases, migrations, and revision metadata.
- Use timestamped output, check completion, and run an integrity check.
- Document a daily scheduling example and retention policy; scheduling can use
  the LXC host's existing automation. A separate in-app scheduler is unnecessary.
- Keep an off-host copy: another file on the same disk is not disaster recovery.
- Restore with the app stopped into a fresh data directory, with correct
  ownership and no leftover WAL/SHM from a different database. Validate integrity
  and schema compatibility before starting the chosen app image.
- Test restoration in a disposable directory/container before declaring the MVP
  deployable. Refresh clients after restore so their local snapshots are replaced.
- Future receipt attachments will require consistent database-plus-files backups;
  the MVP has no attachment storage.

## 10. Proposed project structure

This is the intended project shape, not a rigid file list. The implementation may
consolidate modules and use framework-specific configuration names while keeping
the same responsibilities. In particular, the selected SvelteKit 3 release uses
inline configuration in `vite.config.ts` rather than `svelte.config.js`.

```text
ShoppingList/
├── README.md                         # Setup/use summary after implementation
├── docs/
│   ├── product.md                    # Product behavior and scope
│   ├── architecture.md               # This design
│   ├── implementation-plan.md         # Milestones and acceptance gates
│   ├── future-features.md             # Deferred feature design
│   └── operations.md                  # Deployment, upgrades, backup/restore
├── src/
│   ├── lib/
│   │   ├── components/               # EntryRow, AddItem, GroupSelector,
│   │   │                             # PurchasedSection, ConnectionStatus
│   │   ├── client/
│   │   │   ├── api.ts                # Typed fetch and error handling
│   │   │   ├── snapshot.ts           # Confirmed state, polling, freshness
│   │   │   └── offline.ts            # IndexedDB snapshot storage
│   │   ├── shared/
│   │   │   ├── schemas.ts            # Validation and request/response types
│   │   │   └── normalize.ts          # Consistent name normalization
│   │   └── server/
│   │       ├── config.ts             # Validated runtime configuration
│   │       ├── db/
│   │       │   ├── connection.ts
│   │       │   ├── schema.ts
│   │       │   └── migrate.ts
│   │       └── services/
│   │           ├── entries.ts        # Add/edit/cancel/purchase/undo/archive
│   │           ├── groups.ts
│   │           ├── catalog.ts
│   │           ├── purchases.ts
│   │           └── snapshot.ts
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte              # Mobile UI, client-loaded state
│   │   ├── +page.ts                  # Offline-capable shell configuration
│   │   ├── api/                      # Thin +server.ts handlers
│   │   └── healthz/+server.ts
│   ├── hooks.server.ts               # Trusted host/origin enforcement
│   ├── service-worker.ts             # Shell/static asset cache only
│   └── app.html
├── migrations/                       # Committed generated/reviewed SQL
├── scripts/
│   ├── start.mjs                     # Migrations/bootstrap, then app
│   └── backup.mjs                    # Safe SQLite backup command
├── static/
│   ├── manifest.webmanifest
│   └── icons/
├── tests/
│   ├── unit/
│   ├── integration/                  # Real temporary SQLite DBs
│   └── e2e/                          # Two browsers, mobile, offline
├── Dockerfile
├── compose.yaml
├── .dockerignore
├── .gitignore                        # Exclude data, backups, .env, build output
├── .env.example
├── package.json
├── pnpm-lock.yaml
├── drizzle.config.ts
├── vite.config.ts                    # SvelteKit 3 inline configuration
├── tsconfig.json
└── playwright.config.ts
```

Keep the repository single-package. Split modules when behavior warrants it, not
merely to fill every suggested filename. Framework-generated configuration names
may differ. Do not add monorepo tooling or interfaces for hypothetical databases.
