// HNSW baseline - resident memory and query latency for SurrealDB's HNSW
// vector index. Synthetic random vectors; throwaway container.
//
//   bun tests/hnsw.ts            # default N=20000, dim=2560
//   HNSW_N=50000 bun tests/hnsw.ts
import { startSurreal, randomUnitVector, loadVectors, buildIndex, isErr, IMAGE } from "../lib/harness.ts";
import { banner, heading, spinner, table } from "../lib/tui.ts";

const N = Number(process.env.HNSW_N || 20000);
const DIM = Number(process.env.HNSW_DIM || 2560);
const HNSW = `HNSW DIMENSION ${DIM} DIST COSINE TYPE F32 EFC 150 M 12 M0 24`;

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function rootMemMb(sql: (q: string, o?: { root?: boolean }) => Promise<unknown>): Promise<string> {
  const r = await sql("INFO FOR ROOT;", { root: true });
  const sys = (r as { result?: { system?: { memory_usage?: number } } }[])[0]?.result?.system ?? {};
  return sys.memory_usage ? (sys.memory_usage / 2 ** 20).toFixed(0) + " MiB" : "n/a";
}

banner(IMAGE);
heading(`HNSW baseline - N=${N} · dim=${DIM}`);

const db = await startSurreal({ backend: "memory", port: 18020, name: "sdb-prr-hnsw" });
const rows: Record<string, string>[] = [];
try {
  await db.sql("DEFINE TABLE vec SCHEMALESS;");

  let sp = spinner(`loading ${N} random ${DIM}-dim vectors`);
  const vecs = Array.from({ length: N }, () => randomUnitVector(DIM));
  await loadVectors(db, "vec", vecs);
  sp.done(true, `RSS ${db.dockerStats()}`);
  rows.push({ stage: "after load", rss: db.dockerStats(), surreal: await rootMemMb(db.sql), note: "" });

  sp = spinner(`building HNSW index`);
  const { status, buildSecs } = await buildIndex(db, "vec", HNSW);
  sp.done(status === "ready", `${status} in ${buildSecs}s`);
  rows.push({ stage: "after build", rss: db.dockerStats(), surreal: await rootMemMb(db.sql), note: `${buildSecs}s` });

  sp = spinner(`200 KNN queries`);
  const lat: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = Date.now();
    const r = await db.sql(`SELECT idx FROM vec WHERE embedding <|20,64|> ${vecs[(i * 9973) % N]};`);
    lat.push(Date.now() - t0);
    if (isErr(r)) break;
  }
  lat.sort((a, b) => a - b);
  const p50 = pct(lat, 50), p95 = pct(lat, 95), max = lat[lat.length - 1];
  sp.done(true, `p50 ${p50}ms · p95 ${p95}ms`);
  rows.push({ stage: "after query", rss: db.dockerStats(), surreal: await rootMemMb(db.sql), note: `p50 ${p50}ms p95 ${p95}ms max ${max}ms` });
} finally { db.stop(); }

table(
  [
    { key: "stage", label: "stage", width: 13 },
    { key: "rss", label: "container RSS", width: 16 },
    { key: "surreal", label: "INFO FOR ROOT", width: 14 },
    { key: "note", label: "note", width: 26 },
  ],
  rows,
);
console.log("");
