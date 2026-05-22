// HNSW baseline - resident memory and query latency for SurrealDB's HNSW
// vector index. Synthetic random vectors; throwaway container.
//
//   node tests/hnsw.mjs            # default N=20000, dim=2560
//   HNSW_N=50000 node tests/hnsw.mjs
import { startSurreal, randomUnitVector, loadVectors, buildIndex, isErr, IMAGE } from "../lib/harness.mjs";

const N = +(process.env.HNSW_N || 20000);
const DIM = +(process.env.HNSW_DIM || 2560);
const HNSW = `HNSW DIMENSION ${DIM} DIST COSINE TYPE F32 EFC 150 M 12 M0 24`;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function rootMem(sql) {
  const r = await sql("INFO FOR ROOT;", { root: true });
  const sys = r?.[0]?.result?.system ?? {};
  return { memory_usage: sys.memory_usage, memory_allocated: sys.memory_allocated };
}

console.log(`SurrealDB HNSW baseline - image: ${IMAGE}, N=${N}, dim=${DIM}`);
const db = await startSurreal({ backend: "memory", port: 18020, name: "sdb-prr-hnsw" });
try {
  await db.sql("DEFINE TABLE vec SCHEMALESS;");
  console.log(`generating + loading ${N} random ${DIM}-dim vectors...`);
  const vecs = Array.from({ length: N }, () => randomUnitVector(DIM));
  await loadVectors(db.sql, "vec", vecs);
  console.log(`mem after load:  ${db.dockerStats()}   ${JSON.stringify(await rootMem(db.sql))}`);

  const { status, buildSecs } = await buildIndex(db.sql, "vec", HNSW);
  console.log(`index build:     status=${status} in ${buildSecs}s`);
  console.log(`mem after build: ${db.dockerStats()}   ${JSON.stringify(await rootMem(db.sql))}`);

  // latency: 200 serial KNN queries
  const lat = [];
  for (let i = 0; i < 200; i++) {
    const q = vecs[(i * 9973) % N];
    const t0 = Date.now();
    const r = await db.sql(`SELECT idx FROM vec WHERE embedding <|20,64|> ${q};`);
    lat.push(Date.now() - t0);
    if (isErr(r)) { console.log(`  query ${i} ERR`); break; }
  }
  lat.sort((a, b) => a - b);
  console.log(`latency (200 KNN): p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  max=${lat[lat.length - 1]}ms`);
  console.log(`mem after query: ${db.dockerStats()}   ${JSON.stringify(await rootMem(db.sql))}`);
} finally { db.stop(); }
