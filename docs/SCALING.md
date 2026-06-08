# Scaling a CAW node

Short version: **start native on one box. It scales further than your instinct
says, because a CAW node's database is a re-indexable cache, not a system of
record.** When you do outgrow one box, move Elasticsearch off first, Postgres
second, Redis rarely — each is a single env var, not a re-architecture.

## Why one box goes a long way

The source of truth for CAW social data is **the chain** — the packed action
bytes live in L2 calldata, and events are commitments to that calldata. A
node's Postgres/Redis/Elasticsearch are a *materialized view* of chain state
that the indexers rebuild by re-reading the chain.

This changes the scaling math versus a normal app:

- **No durability requirement on the indexed data.** If a node's Postgres dies,
  you re-index from the chain. You don't need multi-AZ replication, point-in-
  time backups, or a hot standby for the social graph — the expensive parts of
  "database at scale" that most apps can't avoid are optional here.
- **The working set is prunable.** Old indexed CAWs can be dropped and
  re-indexed on demand; the chain still has them. A normal app can't throw away
  its own system of record.
- **A single fat box that occasionally re-indexes is genuinely fine** for a
  community running one Network for thousands of active users, for a long time.

So the default — native install, all three services on `127.0.0.1` — is not a
toy choice you'll regret. It's the right starting point.

> What IS local-only and not on the chain: the TxQueue / signed-payload staging
> and DM relay state. Those are per-node operational state, not the social
> graph. They don't need cross-node durability either; see
> `project_local_only_state_in_mirror`.

## What hits the ceiling first, in order

When a single box does start to strain, the services don't fail together. They
go in this order:

1. **Elasticsearch RAM** — the greediest. ES wants a large JVM heap and competes
   with Postgres, Redis, Node, and the FE build for the box's memory. This is
   almost always the *first* thing that pushes you off one box. It's also the
   cleanest to externalize, because search **degrades gracefully** — if ES is
   unreachable the node keeps working, only search is unavailable.
2. **Postgres working set / connections** — second. Indexed CAWs grow with
   social volume. But remember it's a cache: prune old data and re-index, or
   move Postgres to a bigger/managed box.
3. **Redis** — last and smallest. Session tokens + pending-action queues + tx
   staging. Tiny footprint; rarely the bottleneck.

## The graduation path (one env var per service)

The architecture is already split-ready. Each stateful service points off-box
**independently** via an env var — you flip them one at a time as each gets hot,
without re-architecting anything:

| Service | Env var | When to move it |
|---|---|---|
| Elasticsearch | `CAW_ES_URL` (e.g. `https://your-cluster:9243`) | First — when ES heap crowds the box. Point at a managed cluster (Elastic Cloud, self-hosted ES box). Search keeps working; the node uses the remote indices. |
| Postgres | `CAW_DB_URL` (a full `postgresql://…` URL) | Second — when the DB working set or connection count strains the box. Point at a managed Postgres (RDS, Cloud SQL, a dedicated box). |
| Redis | `CAW_REDIS_URL` (a full `redis://…` URL) | Rarely — only if session/queue volume genuinely needs it. |

These are the same env vars the installer's **"Connect to existing / managed
services"** option (infra mode 3) collects. So "scaling past one box" is:

1. Stand up the managed service (ES cluster / Postgres / Redis).
2. Set the matching `CAW_*` env var.
3. Re-run `caw install --env client/.env` (or hand-edit `.env`) and restart.

No code change, no migration of the social graph — for Postgres you can even
let the node re-index into the new database from the chain rather than dumping
and restoring.

## Multi-node and multi-install isolation

If you run **several CAW nodes on one box** (e.g. `test.caw.social` +
`test2.caw.social`), the installer already isolates them so they share one
Postgres/Redis/ES server without colliding:

- **Postgres** — each install gets its own database, auto-named from the domain
  (`caw_test_caw_social`, `caw_test2_caw_social`).
- **Redis** — each install gets its own logical DB number (`?db=N`),
  auto-assigned by scanning existing installs.
- **Elasticsearch** — each install gets its own index prefix
  (`test_caw_social_*`), derived from the domain, so the flat `caws` / `users` /
  `notifications` indices don't collide.
- **pm2** processes and **nginx** vhosts are domain-suffixed.

So sharing one box across mirrors is fine until that box itself is the limit —
at which point the same graduation path (move ES, then Postgres, off-box)
applies.

## What NOT to do

- **Don't default to Docker for scale.** Docker-on-one-box is still one box's
  RAM and disk — it's a sideways move, not an up, and it adds operational
  surface.
- **Don't over-provision managed services on day one.** A community Network for
  a few thousand users fits on one modest box for a long time *because* the DB
  is a cache. Reach for managed services when a service actually gets hot, not
  before.
- **Don't treat a lost indexer DB as data loss.** It's a cache miss. Re-index.
