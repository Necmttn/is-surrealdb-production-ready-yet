// DiskANN test suite - reproduces the non-deterministic KNN failure in
// SurrealDB 3.1's DISKANN index. Synthetic random vectors; throwaway containers.
//
//   bun tests/diskann.ts [reliability|scale|dimensions|backends|all]
//
// Env: SURREAL_IMAGE (default surrealdb/surrealdb:v3.1.0-beta.3)
import {
  startSurreal, randomUnitVector, loadVectors, buildIndex, knnProbe, IMAGE,
  type Backend,
} from "../lib/harness.ts";
import { banner, heading, spinner, table, paint } from "../lib/tui.ts";

const F32 = (dim: number) =>
  `DISKANN DIMENSION ${dim} DIST COSINE TYPE F32 DEGREE 64 L_BUILD 100 ALPHA 1.2`;
const gen = (n: number, dim: number) => Array.from({ length: n }, () => randomUnitVector(dim));

interface Row {
  case: string; status: string; build: string;
  knn: string; verdict: "pass" | "fail";
}
const QN = 20;
const row = (label: string, status: string, buildSecs: number, ok: number): Row => ({
  case: label, status, build: `${buildSecs}s`,
  knn: `${ok}/${QN}`, verdict: ok === QN ? "pass" : "fail",
});

async function reliability(): Promise<Row[]> {
  heading("reliability - N=1000 · dim=2560 · identical setup ×5");
  const rows: Row[] = [];
  for (let run = 1; run <= 5; run++) {
    const sp = spinner(`run ${run}/5`);
    const db = await startSurreal({ backend: "memory", port: 18011, name: "sdb-prr-rel" });
    try {
      await db.sql("DEFINE TABLE vec SCHEMALESS;");
      const vecs = gen(1000, 2560);
      await loadVectors(db, "vec", vecs);
      const { status, buildSecs } = await buildIndex(db, "vec", F32(2560));
      const { ok } = await knnProbe(db, "vec", vecs, QN);
      const r = row(`run ${run}`, status, buildSecs, ok);
      rows.push(r);
      sp.done(r.verdict === "pass", `KNN ${r.knn}`);
    } finally { db.stop(); }
  }
  return rows;
}

async function scale(): Promise<Row[]> {
  heading("scale - dim=2560 · N = 100 → 5000");
  const rows: Row[] = [];
  const db = await startSurreal({ backend: "memory", port: 18012, name: "sdb-prr-scale" });
  try {
    await db.sql("DEFINE TABLE vec SCHEMALESS;");
    const all = gen(5000, 2560);
    let loaded = 0;
    for (const N of [100, 250, 500, 1000, 2000, 5000]) {
      const sp = spinner(`N=${N}`);
      await loadVectors(db, "vec", all.slice(loaded, N), loaded);
      loaded = N;
      const { status, buildSecs } = await buildIndex(db, "vec", F32(2560));
      const { ok } = await knnProbe(db, "vec", all.slice(0, N), QN);
      const r = row(`N=${N}`, status, buildSecs, ok);
      rows.push(r);
      sp.done(r.verdict === "pass", `KNN ${r.knn}`);
    }
  } finally { db.stop(); }
  return rows;
}

async function dimensions(): Promise<Row[]> {
  heading("dimensions - N=1000 · dim = 4 → 2560");
  const rows: Row[] = [];
  const db = await startSurreal({ backend: "memory", port: 18013, name: "sdb-prr-dim" });
  try {
    for (const dim of [4, 64, 256, 768, 1536, 2560]) {
      const sp = spinner(`dim=${dim}`);
      const tbl = `v${dim}`;
      await db.sql(`DEFINE TABLE ${tbl} SCHEMALESS;`);
      const vecs = gen(1000, dim);
      await loadVectors(db, tbl, vecs);
      const { status, buildSecs } = await buildIndex(db, tbl, F32(dim));
      const { ok } = await knnProbe(db, tbl, vecs, QN);
      const r = row(`dim=${dim}`, status, buildSecs, ok);
      rows.push(r);
      sp.done(r.verdict === "pass", `KNN ${r.knn}`);
    }
  } finally { db.stop(); }
  return rows;
}

async function backends(): Promise<Row[]> {
  heading("backends - N=1000 · dim=2560 · memory / surrealkv / rocksdb");
  const rows: Row[] = [];
  for (const backend of ["memory", "surrealkv", "rocksdb"] as Backend[]) {
    const sp = spinner(backend);
    const db = await startSurreal({ backend, port: 18014, name: "sdb-prr-be" });
    try {
      await db.sql("DEFINE TABLE vec SCHEMALESS;");
      const vecs = gen(1000, 2560);
      await loadVectors(db, "vec", vecs);
      const { status, buildSecs } = await buildIndex(db, "vec", F32(2560));
      const { ok } = await knnProbe(db, "vec", vecs, QN);
      const r = row(backend, status, buildSecs, ok);
      rows.push(r);
      sp.done(r.verdict === "pass", `KNN ${r.knn}`);
    } finally { db.stop(); }
  }
  return rows;
}

const SUITES: Record<string, () => Promise<Row[]>> = { reliability, scale, dimensions, backends };

banner(IMAGE);
const which = process.argv[2] || "all";
const toRun = which === "all" ? Object.keys(SUITES) : [which];
let totalFail = 0;
for (const name of toRun) {
  if (!SUITES[name]) { console.error(paint(`unknown suite: ${name}`, "red")); process.exit(1); }
  const rows = await SUITES[name]();
  table(
    [
      { key: "case", label: "case", width: 12 },
      { key: "status", label: "index", width: 8 },
      { key: "build", label: "build", width: 7 },
      { key: "knn", label: "KNN ok", width: 8 },
      { key: "verdict", label: "verdict", width: 8 },
    ],
    rows,
    (r) => String(r.verdict),
  );
  totalFail += rows.filter((r) => r.verdict === "fail").length;
}
console.log(
  "\n" +
    (totalFail === 0
      ? paint("  all DiskANN cases passed", "green", "bold")
      : paint(`  ${totalFail} DiskANN case(s) failed - KNN search broken`, "red", "bold")) +
    "\n",
);
process.exit(totalFail === 0 ? 0 : 1);
