# Backup and Restore Runbook

How TrustFlow's state is backed up, how to restore it, and what the recovery objectives are.
Companion to [`transaction-boundaries.md`](./transaction-boundaries.md), which explains *why*
the stores are the way they are.

## What actually holds state

This is the part that is easy to get wrong, because it is not what the code suggests.

| Store | Driver | Contents | Consequence of loss |
| --- | --- | --- | --- |
| **Redis** | `ioredis` | Escrows, gigs, auth nonces, refresh tokens, rate-limit counters, idempotency keys, the outbox and its pending events | **Total loss of escrow and gig state.** The audit log is the only surviving record |
| **PostgreSQL** | `pg` | `audit_logs` only | Loss of the audit trail; escrow state itself is unaffected |

There is no ORM and no second copy of the aggregates in Postgres. Redis is the system of record
for anything a user would call "my data", so **a Redis backup is the critical one** — see
`docs/state-model.md` for how each aggregate is keyed.

## RPO / RTO

| Objective | Target | Achieved by | Notes |
| --- | --- | --- | --- |
| **RPO — Redis** | **≤ 24 hours** | `BGSAVE` via `.github/workflows/scheduled-backups.yml` (`cron: '17 3 * * *'`) | Both Redis and Postgres are backed up in the same daily job; a tighter Redis schedule is a known gap (see below) |
| **RPO — Postgres** | **≤ 24 hours** | `pg_dump` in the same daily workflow | Only the audit log; not on the critical path |
| **RTO — Redis** | **≤ 30 minutes** | Restore RDB/AOF into a fresh instance, point `REDIS_URL` at it, restart the app | Bounded by copy time, not by load: the RDB is loaded directly |
| **RTO — Postgres** | **≤ 60 minutes** | `pg_restore`/`psql` replay | A logical backup re-runs the load, so RTO grows with data size |

**These targets are not yet met by anything in this repository.** There is no restore that has
been performed on real data, no offsite copy, and no drill on a schedule. What exists here is
the mechanism plus an automated round-trip test. Treat the numbers above as the intended
contract, and close the gap in the "Known gaps" section before relying on them.

Both Redis and Postgres are backed up by the same daily cron job, so their RPO is currently
identical. Redis is still the more critical store (it is the system of record for escrow and
gig state), but the backup cadence does not yet reflect that — a tighter Redis-only schedule
is listed as a known gap below. Losing `audit_logs` costs only the audit trail; escrow
balances remain reconcilable from the chain via `EscrowReconciliationService`.

## Why Redis persistence is not optional

Redis ships with persistence **off** by default in most managed configurations, and a stock
container has none. With `appendonly no`, a Redis restart silently discards every escrow and
gig, and the application comes back up perfectly healthy having lost all of it — the readiness
probe passes because the data really is gone, not because it is missing.

Minimum acceptable configuration (set in `docker-compose.yml` for local parity, and required
of the production deployment):

```
appendonly yes          # log every write; without this, restart = total loss
appendfsync everysec    # at most ~1s of acknowledged writes lost on power failure
dir /data               # a persistent volume, not the container's ephemeral layer
```

| `appendfsync` | Loss window on power failure | Cost |
| --- | --- | --- |
| `always` | ~0 | An fsync per write; large throughput cost |
| `everysec` | ~1 second | One fsync per second. **Recommended** |
| `no` | up to the OS's own flush interval | Not acceptable for money-adjacent state |

## Backup procedures

### Automated

`.github/workflows/scheduled-backups.yml` runs both scripts daily. It requires the
`BACKUP_DATABASE_URL` and `BACKUP_REDIS_URL` repository secrets; on a fork it skips rather than
fails.

### Manual — PostgreSQL

```bash
cd backend
DATABASE_URL='postgres://user:pass@host:5432/trustflow' \
  BACKUP_DIR=/var/backups/trustflow/postgres \
  BACKUP_RETENTION_DAYS=14 \
  bash scripts/backup-postgres.sh
```

Writes `trustflow-<UTC timestamp>.sql.gz` plus a `.sha256` and a `.meta` sidecar, then prunes
anything older than the retention window. It refuses to record an empty dump as a success, and
a non-zero `pg_dump` exit aborts before the retention step — otherwise a failed run would
eventually delete the last good backup.

### Manual — Redis

```bash
cd backend
REDIS_URL='redis://host:6379' \
BACKUP_DIR=/var/backups/trustflow/redis \
  bash scripts/backup-redis.sh
```

Issues `BGSAVE`, waits for it to finish, and copies `dump.rdb` (plus `appendonlydir` when a
local container is available) into a timestamped directory with a `manifest.sha256` and a
`meta` file recording the key count at snapshot time.

For a fully consistent point-in-time copy while Redis is serving writes, prefer
`redis-cli BGREWRITEAOF` or snapshotting a replica. `BGSAVE` is fork-consistent but captures
only what existed at the fork.

### Retention

14 days by default (`BACKUP_RETENTION_DAYS`). Only files matching this script's own prefix are
pruned, so pointing `BACKUP_DIR` at a shared directory will not delete unrelated content.

**Retention is not a backup strategy.** A backup held only on the machine that produced it has
not been tested against the failure it exists for. Copy snapshots off-host.

## Restore procedures

### PostgreSQL

```bash
cd backend

# 1. Always verify first — this writes nothing.
bash scripts/restore-postgres.sh --file <dump.sql.gz> --verify-only

# 2. Restore for real. --force is required if the target already has tables.
bash scripts/restore-postgres.sh --file <dump.sql.gz> --force
```

The script, in order:

1. Verifies the SHA-256 sidecar. Mismatch → exit `2`, nothing is written.
2. Runs `gzip -t` to catch truncation.
3. Confirms the dump actually contains SQL statements.
4. Refuses to touch a target that already has tables unless `--force` is passed — the dump
   uses `--clean --if-exists`, so it drops objects as it goes and a mistyped target is
   unrecoverable.
5. Restores with `ON_ERROR_STOP=1 --single-transaction`, so the first failing statement aborts
   the whole restore rather than leaving a half-loaded database reported as success.
6. Re-queries `information_schema` to confirm tables exist afterwards.

Exit codes: `1` usage/environment, `2` checksum or integrity failure (**do not trust the
dump**), `3` restore failed.

> **Client/server version skew.** A dump taken by a `pg_dump` newer than the target server can
> fail to restore, because newer clients emit GUCs older servers do not know — `pg_dump` 17+
> writes `SET transaction_timeout`, which does not exist before 17. The script strips that
> line and warns when it detects a skew, but the durable fix is to run `pg_dump` from a host
> whose major version matches the server.

### Redis

```bash
# 1. Recover the files from the snapshot directory.
SNAPSHOT=/var/backups/trustflow/redis/<timestamp>
(cd "$SNAPSHOT" && sha256sum -c manifest.sha256)

# 2a. RDB-only restore: stop the instance, replace the RDB, start it.
docker compose stop redis
cp "$SNAPSHOT/dump.rdb" ./redis-data/dump.rdb
docker compose start redis

# 2b. AOF restore: preserve the directory name and contents exactly.
docker compose stop redis
rm -rf ./redis-data/appendonlydir
cp -r "$SNAPSHOT/appendonlydir" ./redis-data/appendonlydir
docker compose start redis

# 3. Verify.
redis-cli -u "$REDIS_URL" DBSIZE      # compare against the snapshot's `meta` dbsize
redis-cli -u "$REDIS_URL" PING
```

Do **not** start the app against a restored Redis until `DBSIZE` is in the expected range. The
app boots successfully against an empty Redis, and starting it will mint new nonces and write
new escrows into the restored dataset.

### Post-restore checklist

1. `/health/ready` returns 200.
2. `DBSIZE` is plausible versus the snapshot's `meta`.
3. A known escrow resolves: `GET escrow:<id>` returns the expected status and amount.
4. **Re-run reconciliation.** `EscrowReconciliationService` diffs chain state against the DB
   and repairs drift. A restored Redis may be older than the chain, so this is the fastest way
   to find and fix anything the backup missed.
5. Check `escrow_transaction_inconsistent_total` in `/metrics`. A non-zero value means a
   partially applied `MULTI` is outstanding — see the known gaps in
   [`transaction-boundaries.md`](./transaction-boundaries.md).

## Testing

`backend/src/backup/backup-restore.integration.spec.ts` performs a real dump → drop → restore
round trip against a live PostgreSQL, and asserts the failure modes that matter: checksum
mismatch, truncated gzip, a populated target without `--force`, retention pruning, and that a
failed backup exits non-zero instead of recording an empty file as a success.

```bash
cd backend
docker compose -f ../docker-compose.yml up -d postgres
DATABASE_URL='postgres://trustflow:trustflow@localhost:5432/trustflow_dev' \
  npx jest src/backup
```

It skips itself when `DATABASE_URL` is unset, so `npm test` still works without infrastructure.

## Known gaps

1. **No restore has ever been performed against production data.** The mechanism and an
   automated round trip exist; a human has not yet restored a real backup. This is the single
   most important item here.
2. **No offsite or immutable copies.** Snapshots live wherever the runner or host put them. A
   compromise of that host destroys both the live data and the backups.
3. **No scheduled drill.** Nothing restores on a cadence and reports. The `verify` job in the
   workflow restores a *freshly taken* dump, which proves the scripts work but not that a
   3-week-old backup is still restorable or still has the right retention.
4. **RPO/RTO are unvalidated targets**, stated above as a contract rather than a measurement.
5. **Redis is single-instance with no replica.** There is no failover target, so RTO for a
   total Redis loss is bounded by "copy a snapshot and start a new instance" — measured
   regularly, it is likely well over 30 minutes.
6. **Redis RPO is 24 hours, not tighter than Postgres.** Both stores are backed up by the same
   daily workflow (`cron: '17 3 * * *'`). Because Redis is the system of record, a more
   frequent Redis-only backup job (e.g. every 15 minutes) would meaningfully reduce data-loss
   exposure. Until that job exists, Redis and Postgres have the same ≤ 24-hour RPO.
