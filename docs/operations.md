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

| Setting                   | Purpose                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`           | SQLite file; Compose uses `/data/shopping-list.sqlite`                                                          |
| `CANONICAL_ORIGIN`        | Exact browser-facing origin, normally the HTTPS Serve hostname                                                  |
| `PORT`                    | Internal Node/adapter-node port; Compose uses `3000`                                                            |
| `SHUTDOWN_TIMEOUT`        | Maximum adapter-node drain interval in seconds; Compose uses `20`                                               |
| `LOG_LEVEL`               | Reserved application log level (`info` by default)                                                              |
| `PUBLISHED_PORT`          | Host loopback port forwarded to container port 3000                                                             |
| `BACKUP_DIR`              | Backup output directory; Compose mounts `/backups`                                                              |
| `SHOPPING_LIST_IMAGE`     | Optional image reference; unset builds local `shopping-list:local`                                              |
| `RECEIPT_OCR_IMAGE`       | Published OCR sidecar image; unset uses `…/shopping-list-receipt-ocr:latest`, only started by the `ocr` profile |
| `RECEIPT_CURRENCY`        | ISO 4217 code used for receipt money (`USD` by default); invalid codes fail startup                             |
| `RECEIPT_OCR_URL`         | OCR sidecar endpoint (`http`/`https`); unset by default, which disables capture and the worker                  |
| `RECEIPT_OCR_MODE`        | `http` (default) or `stub`, which returns a canned fixture without calling the sidecar                          |
| `RECEIPT_OCR_TIMEOUT_MS`  | Per-request OCR timeout in milliseconds (`30000` by default)                                                    |
| `RECEIPT_OCR_TOKEN`       | Optional bearer token sent to the OCR engine when it is not loopback-only                                       |
| `INDRA_OCR_THREADS`       | Optional OCR sidecar ONNX Runtime inference threads (`4` by default)                                            |
| `RECEIPT_STORAGE_DIR`     | Retained receipt images under the `/data` volume (`/data/receipts` by default)                                  |
| `RECEIPT_IMAGE_RETENTION` | `keep` (capture-first default), `until_commit`, or `immediate`; see "Receipt image retention" below             |
| `BODY_SIZE_LIMIT`         | adapter-node request body cap; set `12M` at deploy, since the upload route still caps images at 10 MB           |

The receipt settings are all optional: with `RECEIPT_OCR_URL` unset the app
boots and runs exactly as before, and already-collected receipts stay readable.
`BODY_SIZE_LIMIT` is read by adapter-node itself, not by the app's config
module, so an invalid receipt setting fails startup loudly while a missing
`BODY_SIZE_LIMIT` silently rejects photo uploads before route code runs.

The `.env` file contains deployment configuration, not authentication secrets;
do not put credentials or tailnet keys in browser-visible settings. Do not commit
`.env` or SQLite/backup files.

## Receipt OCR sidecar (optional)

Receipt capture needs the `receipt-ocr` sidecar: a small CPU-only Python
container wrapping Indra OCR. It is stateless — no database, no files, no queue
of its own — so all three deployment modes run the same app code and the choice
is configuration only:

| Mode                             | Configuration                                                                                             | Behavior                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — sidecar on the same host** | Start the `ocr` profile with `RECEIPT_OCR_URL=http://receipt-ocr:8060/ocr`                                | Default single-box deployment; app and sidecar share the compose network.                                                                                           |
| **B — remote engine**            | `RECEIPT_OCR_URL=http://<magicdns-or-ip>:8060/ocr`, plus `RECEIPT_OCR_TOKEN` when it is not loopback-only | The sidecar (or a heavier engine such as Surya 2 on a GPU/Metal box) runs on another device; only HTTP reachability is required, because the engine keeps no state. |
| **C — off**                      | Leave `RECEIPT_OCR_URL` unset and do not start the `ocr` profile                                          | No worker tick and no capture entry; already-collected receipts stay listable, reviewable and committable.                                                          |

Mode A from a source checkout (builds `./ocr-sidecar`):

```sh
docker compose --profile ocr up -d
```

with `RECEIPT_OCR_URL=http://receipt-ocr:8060/ocr` in `.env`.

Mode A from the published image:

```sh
docker compose -f compose.prod.yaml --profile ocr up -d
```

with `RECEIPT_OCR_URL=http://receipt-ocr:8060/ocr` in `.env`. Set
`RECEIPT_OCR_IMAGE` to the app image name with a `-receipt-ocr` suffix and the
same release tag: the release workflow publishes both images with identical tags
(tag, semver, `sha-…` and `latest`). Leaving the variable unset falls back to the
published `latest` sidecar image, so a deploy without receipt capture never has
to set it.

Both compose services cap the sidecar at about 1 GB of memory, give it a
read-only root filesystem with a 64 MB tmpfs `/tmp`, publish no ports, drop all
Linux capabilities, and set `no-new-privileges`. The Indra models are baked into
the image and `HF_HUB_OFFLINE=1` is set, so the container never fetches models at
start-up; a missing model folder makes it exit instead of reaching the network.

Verify a running sidecar with the bundled smoke check. It calls `/healthz` and
posts the baked fixture image to `/ocr`, asserting the lines/blocks contract the
app consumes:

```sh
docker compose exec -T receipt-ocr python smoke.py
docker exec <container> python smoke.py            # same check from the host shell
```

Prove the image needs no network at all:

```sh
docker run --rm -d --name ocr-offline --network none --read-only \
  --tmpfs /tmp --memory 1g "$RECEIPT_OCR_IMAGE"
docker exec ocr-offline python smoke.py
```

Set `RECEIPT_OCR_TOKEN` to the same value on both containers when the engine
listens beyond the compose network (deployment mode B in the plan): the app
sends it as a bearer header, and the sidecar rejects `/ocr` without it. Keep the
value out of version control. `RECEIPT_OCR_TIMEOUT_MS` (30 s by default) bounds
each attempt; a down or slow sidecar retries up to three times and then marks the
receipt `failed` with a visible error, while the app stays healthy. See
`ocr-sidecar/README.md` for the full contract and image invariants.

### Receipt image retention

`RECEIPT_IMAGE_RETENTION` is the storage escape hatch and defaults to `keep`,
the capture-first posture: captured images stay in `RECEIPT_STORAGE_DIR` and are
archived by every backup run.

| Value            | Intended effect (see the caveat below)                                        |
| ---------------- | ----------------------------------------------------------------------------- |
| `keep` (default) | Images are retained indefinitely.                                             |
| `until_commit`   | A receipt drops its image once it commits.                                    |
| `immediate`      | The image is dropped without waiting for review, which then stays text-first. |

In R1 the app accepts, validates and defaults the setting but does not yet purge
automatically, so **every value currently behaves like `keep`**. The only
deletion today is an explicit discard, which purges the image after a confirm and
keeps the OCR text and lines. OCR text, parsed lines and prices live in SQLite
regardless, and a receipt whose image is gone renders in the review pane with a
"purged" note instead of an error. If storage becomes a concern before the
retention modes land, run a backup first so the images exist in an archive, then
prune `RECEIPT_STORAGE_DIR` and back up again.

Scale check: a capture is roughly 100–500 KB, so a couple of thousand trips stay
under about 1 GB — a growth consideration, not a scarcity.

## Backups

Run a verified online backup from the running container:

```sh
docker compose -f compose.prod.yaml exec -T shopping-list node scripts/backup.mjs
```

Each run writes a matched pair of artifacts under `/backups` (or `BACKUP_DIR`):

- `shopping-list-<timestamp>-<uuid>.sqlite` — the database backup. It checks both
  `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and is created with
  owner-only permissions. It uses SQLite's online backup API, so do not replace
  it with a live `cp` of only the `.sqlite` file while WAL writes may be pending;
  the result is checkpointed into a standalone SQLite file.
- `shopping-list-<timestamp>-<uuid>-receipts.tar` — everything still in
  `RECEIPT_STORAGE_DIR` (in practice the `<uuid>.<ext>` receipt images), stored
  uncompressed because the images are already JPEG/PNG/WebP. In-flight upload
  spool files and symlinks are excluded, and the archive is verified against the
  bytes written.

The two files share one run id, so a restore cannot pair one run's database with
another run's images. The database is written first and the images second: with
the capture-first default every image a backed-up receipt row references is in
the archive, while a spare image is harmless. An archive reporting `0 images`
means no capture images were on disk at that moment (before any capture, or after
they were discarded), so the database half is still a complete backup.

Schedule it daily with the LXC host's existing scheduler, for example:

```cron
30 2 * * * cd /opt/shopping-list && docker compose -f compose.prod.yaml exec -T shopping-list node scripts/backup.mjs
```

Choose and periodically test a retention policy. Keep at least one encrypted,
off-host copy; another directory or volume on the same LXC disk is not disaster
recovery. Restrict access to backups because they contain the household list,
purchase history and receipt images. A simple starting policy is to keep the most
recent 30 daily backups and 12 monthly copies off-host, and to copy both halves of
a run together; adapt retention to the household's recovery needs and available
storage.

For a local development database, set `BACKUP_DIR=./backups` and run
`pnpm db:backup` from the project root.

## Restore and upgrades

1. Stop the application: `docker compose -f compose.prod.yaml stop shopping-list`.
2. Preserve the current data directory before attempting recovery.
3. Restore a verified backup into a **fresh** data directory. Pick one backup
   run and restore both of its artifacts — the `-receipts.tar` file must carry
   the same run id as the `.sqlite` file. For example, from the project directory
   inside the LXC:

   ```sh
   mv data "data-before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p data/receipts
   install -o 10001 -g 10001 -m 0600 \
     backups/shopping-list-<run-id>.sqlite data/shopping-list.sqlite
   tar -xf backups/shopping-list-<run-id>-receipts.tar \
     -C data/receipts --no-same-owner
   chown -R 10001:10001 data/receipts
   ```

   Use the correct outer-LXC/container UID mapping for the bind mount.
   `--no-same-owner` is deliberate: the archive records no meaningful ownership,
   and the `chown` hands the images back to the container's fixed UID/GID. A
   fresh directory ensures there is no `shopping-list.sqlite-wal` or
   `shopping-list.sqlite-shm` from a different database beside the restored
   file, and no stale images beside the restored ones. Check that the restored
   `data/receipts` and the restored database agree — every
   `receipts.image_path` that is not `NULL` should have a file; an extra file
   (for example one whose upload landed after the database snapshot) is
   harmless.

4. Start the app with `docker compose -f compose.prod.yaml up -d` and verify the
   health check, current list, and purchase history. Open a receipt to confirm
   its image renders. Startup applies compatible migrations before accepting
   traffic. A new process instance causes open clients to fetch the authoritative
   restored snapshot even if its revision is lower than before.
5. Before an upgrade, create and verify a backup. For a GHCR deployment, update
   `SHOPPING_LIST_IMAGE`, then run `docker compose -f compose.prod.yaml pull`
   and `docker compose -f compose.prod.yaml up -d`. For a source checkout,
   rebuild from the chosen pinned revision. Inspect startup logs. Migrations are
   forward-applied before serving; do not roll back to an older image after an
   incompatible migration without restoring a compatible backup.

Test restores in a disposable directory/container before treating the backup
schedule as operationally ready. The automated test suite exercises a full
backup run and restores the database plus the receipt images into a temporary
directory; it does not replace a restore test on the actual LXC storage and UID
mapping.

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
