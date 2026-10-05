# Operations

This deployment has one SvelteKit/Node application process and one SQLite
database on local persistent storage. There is no application login: tailnet
access control is the access-control boundary.

## Network topology

```text
authorized tailnet browser
  -> Tailscale Serve HTTPS hostname
  -> host/LXC 127.0.0.1:3000
  -> Compose container :3000
  -> SQLite in /data
```

Compose binds the host port to `127.0.0.1`, not the LAN or public interfaces.
For this topology, run the Tailscale node/Serve process inside the **same LXC**
as Compose, so its loopback is the loopback where Docker published the app.
Configure Serve to proxy the chosen tailnet HTTPS name to that loopback port.
With a current Tailscale CLI, the basic proxy command is:

```sh
sudo tailscale serve --bg http://127.0.0.1:3000
tailscale serve status
```

If `PUBLISHED_PORT` is changed from its default, point Serve at that loopback
port instead of `3000`.

Do not run the command on the Proxmox host and assume its `127.0.0.1` can reach
the LXC's loopback. If Tailscale must run on the Proxmox host, stop and choose a
different verified private host-to-LXC topology rather than publishing the app
on an unrestricted interface.

The `CANONICAL_ORIGIN` value must exactly match the HTTPS origin shown to users,
for example `https://shopping-list.<your-tailnet>.ts.net` (no path or trailing
slash is required). SvelteKit's `ORIGIN` is set from this value at startup. The
app rejects requests with a different Host and rejects cross-origin or
non-JSON mutations. Do not enable Tailscale Funnel. Restrict tailnet access to
the intended household devices/users with your tailnet ACLs or grants.

The app does not trust arbitrary `X-Forwarded-Host` or `X-Forwarded-Proto`
headers. Keep the Serve proxy on the selected topology and do not add an
untrusted proxy in front of it.

## Proxmox LXC and first deployment

Use a supported Docker Engine and Compose v2 installation in the LXC. Verify
Docker's nesting/cgroup requirements with the Proxmox version and LXC settings
in use. An unprivileged LXC may work when configured for Docker; do not make the
LXC privileged or disable isolation as a workaround. Keep the database and
backup directories on local storage, not a network filesystem.

From the application directory inside the LXC:

1. For a GHCR deployment, place `compose.prod.yaml` and `.env.prod.example` in
   the deployment directory. You can download them from a public GitHub release
   without cloning the repo:

   ```sh
   mkdir -p /opt/shopping-list
   cd /opt/shopping-list
   wget -O compose.prod.yaml \
     https://raw.githubusercontent.com/dustin-ward/shopping-list/vX.Y.Z/compose.prod.yaml
   wget -O .env.prod.example \
     https://raw.githubusercontent.com/dustin-ward/shopping-list/vX.Y.Z/.env.prod.example
   cp .env.prod.example .env
   vi .env
   ```

   Set `CANONICAL_ORIGIN` to the Serve HTTPS hostname and `SHOPPING_LIST_IMAGE`
   to the published GHCR tag. `PUBLISHED_PORT` is the host loopback port; the
   container listens on port 3000. For a private GitHub repo, copy these two
   files from a trusted workstation instead of downloading unauthenticated raw
   URLs.

2. Create the bind-mount directories and grant the container's fixed UID/GID
   access:

   ```sh
   mkdir -p data backups
   sudo chown -R 10001:10001 data backups
   ```

   The image runs as UID/GID `10001:10001` (`shopping`). Bind mounts in an
   unprivileged LXC may map host IDs differently; verify ownership from inside
   the LXC and from the container before relying on the service.

3. Start one replica. For a GHCR deployment, authenticate first if the package
   is private, then pull and start the prebuilt image:

   ```sh
   docker compose -f compose.prod.yaml pull
   docker compose -f compose.prod.yaml up -d
   docker compose -f compose.prod.yaml ps
   docker compose -f compose.prod.yaml logs --tail=100 shopping-list
   ```

   For a source checkout, use `compose.yaml` to build and start the container:

   ```sh
   docker compose up --build -d
   ```

4. Configure Tailscale Serve as above and verify the app from a tailnet device.
   Confirm that the service is not reachable through the LXC's LAN address or
   any public port.

The image pins a Node LTS image digest, installs only production dependencies in
the runtime stage, and runs as a non-root user. SQLite migrations and the
idempotent shared-list bootstrap run before the HTTP server starts. The Compose
health check verifies the ready endpoint. Run only one replica.

## Configuration

| Setting               | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `DATABASE_PATH`       | SQLite file; Compose uses `/data/shopping-list.sqlite`             |
| `CANONICAL_ORIGIN`    | Exact browser-facing origin, normally the HTTPS Serve hostname     |
| `PORT`                | Internal Node/adapter-node port; Compose uses `3000`               |
| `SHUTDOWN_TIMEOUT`    | Maximum adapter-node drain interval in seconds; Compose uses `20`  |
| `LOG_LEVEL`           | Reserved application log level (`info` by default)                 |
| `PUBLISHED_PORT`      | Host loopback port forwarded to container port 3000                |
| `BACKUP_DIR`          | Backup output directory; Compose mounts `/backups`                 |
| `SHOPPING_LIST_IMAGE` | Optional image reference; unset builds local `shopping-list:local` |

The `.env` file contains deployment configuration, not authentication secrets;
do not put credentials or tailnet keys in browser-visible settings. Do not commit
`.env` or SQLite/backup files.

## Backups

Run a verified online backup from the running container:

```sh
docker compose -f compose.prod.yaml exec -T shopping-list node scripts/backup.mjs
```

The command writes a timestamped `shopping-list-*.sqlite` file under `/backups`
and checks both `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. It uses
SQLite's online backup API, so do not replace it with a live `cp` of only the
`.sqlite` file while WAL writes may be pending. The generated backup is
checkpointed into a standalone SQLite file and created with owner-only
permissions.

Schedule it daily with the LXC host's existing scheduler, for example:

```cron
30 2 * * * cd /opt/shopping-list && docker compose -f compose.prod.yaml exec -T shopping-list node scripts/backup.mjs
```

Choose and periodically test a retention policy. Keep at least one encrypted,
off-host copy; another directory or volume on the same LXC disk is not disaster
recovery. Restrict access to backups because they contain the household list and
purchase history. A simple starting policy is to keep the most recent 30 daily
backups and 12 monthly copies off-host; adapt retention to the household's
recovery needs and available storage.

For a local development database, set `BACKUP_DIR=./backups` and run
`pnpm db:backup` from the project root.

## Restore and upgrades

1. Stop the application: `docker compose -f compose.prod.yaml stop shopping-list`.
2. Preserve the current data directory before attempting recovery.
3. Restore a verified backup into a **fresh** data directory. For example, from
   the project directory inside the LXC:

   ```sh
   mv data "data-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir data
   install -o 10001 -g 10001 -m 0600 \
     backups/shopping-list-<timestamp>.sqlite data/shopping-list.sqlite
   ```

   Use the correct outer-LXC/container UID mapping for the bind mount. A fresh
   directory ensures there is no `shopping-list.sqlite-wal` or
   `shopping-list.sqlite-shm` from a different database beside the restored file.

4. Start the app with `docker compose -f compose.prod.yaml up -d` and verify the
   health check, current list, and purchase history. Startup applies compatible
   migrations before accepting traffic. A new process instance causes open
   clients to fetch the authoritative restored snapshot even if its revision is
   lower than before.
5. Before an upgrade, create and verify a backup. For a GHCR deployment, update
   `SHOPPING_LIST_IMAGE`, then run `docker compose -f compose.prod.yaml pull`
   and `docker compose -f compose.prod.yaml up -d`. For a source checkout,
   rebuild from the chosen pinned revision. Inspect startup logs. Migrations are
   forward-applied before serving; do not roll back to an older image after an
   incompatible migration without restoring a compatible backup.

Test restores in a disposable directory/container before treating the backup
schedule as operationally ready. The automated SQLite test suite exercises a
backup and restore into a temporary database; it does not replace a restore test
on the actual LXC storage and UID mapping.

## Troubleshooting

- **Origin/Host rejected:** check that `CANONICAL_ORIGIN` is the exact HTTPS
  browser origin and that Tailscale Serve forwards the original Host. Do not
  work around the check by trusting arbitrary forwarded headers.
- **Container unhealthy:** inspect `docker compose -f compose.prod.yaml logs`; startup configuration
  errors and migration failures are logged before the app starts listening.
- **SQLite permission error:** verify `/data` is writable by UID 10001 inside
  the container and that the volume is local storage.
- **Offline view unavailable:** the browser may have evicted storage, local
  storage may be disabled/quota-limited, or this device's saved data may have
  been cleared. Reconnect and load the list successfully before going offline.
- **Data recovery:** stop the service, restore to a fresh data directory, check
  ownership/integrity, and reconnect clients to replace their cached snapshots.

Actual Proxmox LXC, tailnet ACL/Serve configuration, and physical iOS/Android
browser checks must be recorded for the specific household deployment.
