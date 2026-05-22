# is-surrealdb-production-ready-yet

A small, self-contained set of reproducible tests and benchmarks for the
SurrealDB behaviours we hit running a real vector workload in production.

Every test uses **synthetic random vectors** and a throwaway Docker container -
no external data, no credentials, nothing to set up beyond Docker + Node.

> Status (2026-05-22, SurrealDB `v3.1.0-beta.3` and `nightly`): the **DiskANN**
> vector index is **not** production-ready - see below. HNSW works but has a
> latency cliff under query load.

## TL;DR findings

| Area | Finding |
|------|---------|
| **DiskANN KNN search** | **Non-deterministically broken.** An index reports `INFO FOR INDEX status: ready`, but KNN queries fail ~95-100% of the time with `DiskANN KNN search failed`. Re-running the *identical* setup flips between fully-working and fully-broken. |
| DiskANN - surface | Server log shows `ANNError: DiskANN(IndexError) DiskANN element <N> is missing` from index compaction (`core/src/idx/trees/diskann/provider.rs`). The index claims `ready` while compaction silently drops elements. |
| DiskANN - scope | Reproduces on `v3.1.0-beta.3` **and** `nightly`; on the `memory`, `surrealkv` **and** `rocksdb` backends; with random data; at dimensions ≥ ~768 and counts ≥ ~500. Even the pure in-`memory` backend fails - so the fault is in the DiskANN provider, not storage/compaction. |
| HNSW - memory | A 2560-dim HNSW index over 147k vectors holds the whole graph in process memory: RSS ~8.5 GiB after build, ~11.4 GiB after a query load. Memory is not bounded by a cache. |
| HNSW - latency | Under a serial query load, p50 ~31 ms but **p95 ~11.5 s** - consistent with read-lock starvation during HNSW search. |

Raw collected output is in [`results/`](./results).

## Why this repo exists

We run a knowledge-graph vector workload (~141k embeddings, 2560-dim) on
SurrealDB. SurrealDB is marketed as a vector-native, multi-model database. In
practice the vector layer has cost us a recurring production incident. This
repo is the minimal, honest, reproducible evidence - so anyone evaluating
SurrealDB for vector search can check the current state for themselves, and so
the findings are easy to hand to the SurrealDB team.

It is meant to be **kept current**: bump `SURREAL_IMAGE`, re-run, update the
table. The day DiskANN passes, this repo should say so.

## Requirements

- Docker
- Node.js ≥ 20

## Run it

```bash
# the headline: DiskANN non-determinism (identical setup, x5)
node tests/diskann.mjs reliability

# DiskANN across vector counts / dimensions / storage backends
node tests/diskann.mjs scale
node tests/diskann.mjs dimensions
node tests/diskann.mjs backends

# everything
node tests/diskann.mjs all

# HNSW memory + latency baseline
node tests/hnsw.mjs

# test a different build
SURREAL_IMAGE=surrealdb/surrealdb:nightly node tests/diskann.mjs reliability
```

Each run spins a fresh `surrealdb` container, generates random unit vectors,
builds the index, probes it, and tears the container down.

## What each test does

- **`diskann.mjs reliability`** - builds a DiskANN index on 1000 random
  2560-dim vectors, runs 20 KNN queries, repeats 5× with identical inputs.
  A correct index returns `20 ok / 0 fail` every run. DiskANN does not.
- **`diskann.mjs scale`** - dim 2560, vector count 100 → 5000.
- **`diskann.mjs dimensions`** - 1000 vectors, dimension 4 → 2560.
- **`diskann.mjs backends`** - 1000×2560, `memory` vs `surrealkv` vs `rocksdb`.
- **`hnsw.mjs`** - builds an HNSW index, reports resident memory (`docker
  stats` + `INFO FOR ROOT`) and query latency (p50/p95).

## Reproducing the DiskANN bug by hand

```surql
-- SurrealDB v3.1.0-beta.3, `memory` backend is enough
DEFINE NAMESPACE t; USE NS t; DEFINE DATABASE t;
DEFINE TABLE vec SCHEMALESS;
-- INSERT ~1000 rows, each: { idx: N, embedding: <random 2560-float unit vector> }
DEFINE INDEX vidx ON vec FIELDS embedding
  DISKANN DIMENSION 2560 DIST COSINE TYPE F32 DEGREE 64 L_BUILD 100 ALPHA 1.2 CONCURRENTLY;
INFO FOR INDEX vidx ON vec;          -- => building.status = "ready"
SELECT idx FROM vec WHERE embedding <|20,64|> [/* a random 2560-float vector */];
-- => { "status": "ERR", "result": "DiskANN KNN search failed" }
```

## Scope / honesty

- These are black-box behavioural tests, not a SurrealDB audit. They cover the
  vector-index surface only.
- Beta software is expected to have bugs; the point of the repo is a precise,
  current, reproducible record - not a verdict on the whole database.
- SurrealDB's graph + document model is not under test here and is not the
  subject of the findings.

## License

MIT - see [LICENSE](./LICENSE).
