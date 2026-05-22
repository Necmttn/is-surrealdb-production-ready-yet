# is-surrealdb-production-ready-yet

Reproducible tests + benchmarks for the SurrealDB **vector-index** behaviour we
hit running a real workload (~141k embeddings, 2560-dim) in production.

Every test uses **synthetic random vectors** and a throwaway Docker container -
no external data, no credentials. Runs with [Bun](https://bun.sh).

```bash
bun tests/diskann.ts reliability     # the headline finding
bun tests/diskann.ts all             # full DiskANN matrix
bun tests/hnsw.ts                    # HNSW memory + latency
SURREAL_IMAGE=surrealdb/surrealdb:nightly bun tests/diskann.ts all
```

---

## Verdict (2026-05-22)

| Index | Image(s) | Production-ready? |
|-------|----------|-------------------|
| **DiskANN** | `v3.1.0-beta.3`, `nightly` | **No** - KNN search non-deterministically fails |
| **HNSW** | `v3.0.x`, `v3.1.x` | Works, but unbounded memory + p95 latency cliff |

---

## DiskANN - the bug

A `DISKANN` index reports `INFO FOR INDEX status: ready`, but KNN queries
(`<|K,EF|>`) **fail ~95-100% of the time** with `DiskANN KNN search failed`.
Re-running the *identical* setup flips between working and broken. The server
log shows the index silently corrupting during compaction:

```
WARN  surrealdb_core::kvs::ds: Index compaction ... fails: ANNError: DiskANN(IndexError)
DiskANN element 1000 is missing -- (core/src/idx/trees/diskann/provider.rs:594)
```

### Test matrix

`✅` = 20/20 KNN queries succeeded · `❌` = mostly/all failed · all DiskANN F32, COSINE, defaults.

**Vector count** (dim 2560, `memory` backend):

| N | 100 | 250 | 500 | 1 000 | 2 000 | 5 000 | 147 000 |
|---|-----|-----|-----|-------|-------|-------|---------|
| KNN | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Dimension** (N = 1 000, `memory` backend):

| dim | 4 | 64 | 256 | 768 | 1 536 | 2 560 |
|-----|---|----|----|-----|-------|-------|
| KNN | ✅ | ✅ | ✅ | ⚠️ flaky | ❌ | ❌ |

**Storage backend** (N = 1 000, dim 2 560):

| backend | `memory` | `surrealkv` | `rocksdb` |
|---------|----------|-------------|-----------|
| KNN | ❌ | ❌ | ❌ |

**Reliability** (N = 1 000, dim 2 560 - identical setup, repeated):

| run | 1 | 2 | 3 | 4 | 5 |
|-----|---|---|---|---|---|
| KNN | ❌ | ❌ | ❌ | ❌ | ❌ |

**Image:** fails on both `v3.1.0-beta.3` (2026-05-14) and `nightly` (2026-05-21).

### Reading the matrix

It is **not** a clean threshold. Small `N` *or* small `dim` raises the odds of
success, but nothing is reliable - `dim 768 / N 1000` passed `20/20` in one run
and failed `1/20` in the next. Even the pure in-`memory` backend fails, so the
fault is in the DiskANN provider itself, not storage or KV compaction. The
failure is a **race in index build / compaction**.

### Reproduce by hand

```surql
-- SurrealDB v3.1.0-beta.3, `memory` backend is enough
DEFINE NAMESPACE t; USE NS t; DEFINE DATABASE t;
DEFINE TABLE vec SCHEMALESS;
-- INSERT ~1000 rows, each { idx: N, embedding: <random 2560-float unit vector> }
DEFINE INDEX vidx ON vec FIELDS embedding
  DISKANN DIMENSION 2560 DIST COSINE TYPE F32 DEGREE 64 L_BUILD 100 ALPHA 1.2 CONCURRENTLY;
INFO FOR INDEX vidx ON vec;          -- building.status = "ready"
SELECT idx FROM vec WHERE embedding <|20,64|> [/* random 2560-float vector */];
-- => { "status": "ERR", "result": "DiskANN KNN search failed" }
```

---

## HNSW - works, with caveats

HNSW is the index that actually functions. Two things to know before relying
on it (measured: 147k random 2560-dim F32 vectors, `bun tests/hnsw.ts`):

| stage | container RSS | note |
|-------|---------------|------|
| after load | ~0.9 GiB | |
| after index build | ~8.5 GiB | build ~330 s |
| after 200 KNN queries | ~11.4 GiB | p50 ~31 ms · **p95 ~11.5 s** |

- **Memory is unbounded** - the whole graph lives in process RSS; there is no
  cache cap. Index size grows with vector count and dimension.
- **p95 latency cliff** - under a serial query load, p95 was ~11.5 s vs a
  31 ms p50, consistent with a read-lock held across HNSW search.

---

## Embedding size reference

Storage is `dimension × bytes-per-component`. SurrealDB's HNSW keeps this
**resident in RAM**; pick dimension and precision accordingly.

| precision | bytes / component |
|-----------|-------------------|
| `F64` | 8 |
| `F32` | 4 |
| `F16` | 2 |
| `I8` / `U8` | 1 |

| model (example) | dim | bytes/vec `F32` | `F16` | `I8` | raw @ 141k vec, `F32` |
|-----------------|-----|-----------------|-------|------|------------------------|
| MiniLM-L6, BGE-small | 384 | 1.5 KB | 0.75 KB | 0.38 KB | ~0.22 GB |
| BGE-base, nomic-text | 768 | 3.0 KB | 1.5 KB | 0.75 KB | ~0.43 GB |
| BGE-large, Cohere v3, Qwen3-0.6B | 1024 | 4.0 KB | 2.0 KB | 1.0 KB | ~0.58 GB |
| OpenAI text-embedding-3-small | 1536 | 6.0 KB | 3.0 KB | 1.5 KB | ~0.87 GB |
| Qwen3-Embedding-4B *(this workload)* | 2560 | 10.0 KB | 5.0 KB | 2.5 KB | ~1.44 GB |
| OpenAI text-embedding-3-large | 3072 | 12.0 KB | 6.0 KB | 3.0 KB | ~1.73 GB |
| Qwen3-Embedding-8B | 4096 | 16.0 KB | 8.0 KB | 4.0 KB | ~2.31 GB |

Raw vectors are only part of it - the HNSW graph adds ~1.3-2× on top, and the
index is held in memory. Halving precision (`F32→F16`) or using a smaller
embedding model is the cheapest lever on SurrealDB HNSW memory.

---

## What each test does

| command | what it measures |
|---------|------------------|
| `bun tests/diskann.ts reliability` | identical setup ×5 - exposes the non-determinism |
| `bun tests/diskann.ts scale` | dim 2560, N 100 → 5000 |
| `bun tests/diskann.ts dimensions` | N 1000, dim 4 → 2560 |
| `bun tests/diskann.ts backends` | `memory` / `surrealkv` / `rocksdb` |
| `bun tests/hnsw.ts` | HNSW resident memory + p50/p95 latency |

Each run spins a fresh `surrealdb` container, generates random unit vectors,
builds the index, probes it, tears the container down. `SURREAL_IMAGE` env var
selects the build.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Docker

## Scope / honesty

These are black-box behavioural tests of the **vector-index surface only** -
not a SurrealDB audit, not a verdict on the whole database. SurrealDB's graph +
document model is not under test here. Beta software is expected to have bugs;
the value of this repo is a precise, current, reproducible record. The day
DiskANN passes, this README should say so - bump `SURREAL_IMAGE`, re-run,
update the matrix.

Raw collected output is in [`results/`](./results).

## License

MIT - see [LICENSE](./LICENSE).
