// DiskANN test suite - reproduces the non-deterministic KNN failure in
// SurrealDB 3.1's DISKANN index. All synthetic random vectors; no external data.
//
//   node tests/diskann.mjs [reliability|scale|dimensions|backends|all]
//
// Env: SURREAL_IMAGE (default surrealdb/surrealdb:v3.1.0-beta.3)
import { startSurreal, randomUnitVector, loadVectors, buildIndex, knnProbe, IMAGE } from "../lib/harness.mjs";

const F32 = (dim) => `DISKANN DIMENSION ${dim} DIST COSINE TYPE F32 DEGREE 64 L_BUILD 100 ALPHA 1.2`;
const gen = (n, dim) => Array.from({ length: n }, () => randomUnitVector(dim));

// ---------------------------------------------------------------------------
// reliability: same setup, repeated - shows the non-determinism
// ---------------------------------------------------------------------------
async function reliability() {
  console.log(`\n## reliability - N=1000, dim=2560, identical setup x5\n`);
  const rows = [];
  for (let run = 1; run <= 5; run++) {
    const db = await startSurreal({ backend: "memory", port: 18011, name: "sdb-prr-rel" });
    try {
      await db.sql("DEFINE TABLE vec SCHEMALESS;");
      const vecs = gen(1000, 2560);
      await loadVectors(db.sql, "vec", vecs);
      const { status, buildSecs } = await buildIndex(db.sql, "vec", F32(2560));
      const { ok, fail, lastError } = await knnProbe(db.sql, "vec", vecs, 20);
      rows.push({ run, status, buildSecs, ok, fail, note: lastError || db.logs() });
      console.log(`  run ${run}: index=${status} build=${buildSecs}s  KNN ${ok} ok / ${fail} fail  ${lastError}`);
    } finally { db.stop(); }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// scale: dim=2560, growing N
// ---------------------------------------------------------------------------
async function scale() {
  console.log(`\n## scale - dim=2560, N = 100..5000\n`);
  const db = await startSurreal({ backend: "memory", port: 18012, name: "sdb-prr-scale" });
  const rows = [];
  try {
    await db.sql("DEFINE TABLE vec SCHEMALESS;");
    const all = gen(5000, 2560);
    let loaded = 0;
    for (const N of [100, 250, 500, 1000, 2000, 5000]) {
      await loadVectors(db.sql, "vec", all.slice(loaded, N), loaded); // incremental
      loaded = N;
      const { status, buildSecs } = await buildIndex(db.sql, "vec", F32(2560));
      const { ok, fail, lastError } = await knnProbe(db.sql, "vec", all.slice(0, N), 20);
      rows.push({ N, status, buildSecs, ok, fail });
      console.log(`  N=${N}: index=${status} build=${buildSecs}s  KNN ${ok} ok / ${fail} fail  ${lastError}`);
    }
  } finally { db.stop(); }
  return rows;
}

// ---------------------------------------------------------------------------
// dimensions: N=1000, varying DIMENSION
// ---------------------------------------------------------------------------
async function dimensions() {
  console.log(`\n## dimensions - N=1000, dim = 4..2560\n`);
  const db = await startSurreal({ backend: "memory", port: 18013, name: "sdb-prr-dim" });
  const rows = [];
  try {
    for (const dim of [4, 64, 256, 768, 1536, 2560]) {
      const tbl = `v${dim}`;
      await db.sql(`DEFINE TABLE ${tbl} SCHEMALESS;`);
      const vecs = gen(1000, dim);
      await loadVectors(db.sql, tbl, vecs);
      const { status, buildSecs } = await buildIndex(db.sql, tbl, F32(dim));
      const { ok, fail, lastError } = await knnProbe(db.sql, tbl, vecs, 20);
      rows.push({ dim, status, buildSecs, ok, fail });
      console.log(`  dim=${dim}: index=${status} build=${buildSecs}s  KNN ${ok} ok / ${fail} fail  ${lastError}`);
    }
  } finally { db.stop(); }
  return rows;
}

// ---------------------------------------------------------------------------
// backends: N=1000, dim=2560, memory vs surrealkv vs rocksdb
// ---------------------------------------------------------------------------
async function backends() {
  console.log(`\n## backends - N=1000, dim=2560\n`);
  const rows = [];
  for (const backend of ["memory", "surrealkv", "rocksdb"]) {
    const db = await startSurreal({ backend, port: 18014, name: "sdb-prr-be" });
    try {
      await db.sql("DEFINE TABLE vec SCHEMALESS;");
      const vecs = gen(1000, 2560);
      await loadVectors(db.sql, "vec", vecs);
      const { status, buildSecs } = await buildIndex(db.sql, "vec", F32(2560));
      const { ok, fail, lastError } = await knnProbe(db.sql, "vec", vecs, 20);
      rows.push({ backend, status, buildSecs, ok, fail });
      console.log(`  ${backend}: index=${status} build=${buildSecs}s  KNN ${ok} ok / ${fail} fail  ${lastError}`);
    } finally { db.stop(); }
  }
  return rows;
}

const SUITES = { reliability, scale, dimensions, backends };

const which = process.argv[2] || "all";
console.log(`SurrealDB DiskANN suite - image: ${IMAGE}`);
const toRun = which === "all" ? Object.keys(SUITES) : [which];
const out = {};
for (const name of toRun) {
  if (!SUITES[name]) { console.error(`unknown suite: ${name}`); process.exit(1); }
  out[name] = await SUITES[name]();
}
console.log("\n" + JSON.stringify(out, null, 2));
