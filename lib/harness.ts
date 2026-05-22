// Test harness: spin a throwaway SurrealDB container, talk to it over HTTP,
// generate clean synthetic vectors. No external data, no prod anything.
// Runs under `bun`.
import { execSync } from "node:child_process";

export const IMAGE = process.env.SURREAL_IMAGE || "surrealdb/surrealdb:v3.1.0-beta.3";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Backend = "memory" | "rocksdb" | "surrealkv";
export type Json = unknown;

/** One random unit-norm vector of `dim` floats, as a JSON-array string. */
export function randomUnitVector(dim: number): string {
  const v = new Array<number>(dim);
  let mag = 0;
  for (let i = 0; i < dim; i++) {
    const x = Math.random() * 2 - 1;
    v[i] = x;
    mag += x * x;
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dim; i++) v[i] = +(v[i] / mag).toFixed(7);
  return "[" + v.join(",") + "]";
}

export interface Surreal {
  sql: (q: string, opts?: { root?: boolean }) => Promise<Json>;
  dockerStats: () => string;
  logs: (grep?: string) => string;
  stop: () => void;
}

/** Start a throwaway SurrealDB container and return a client. */
export async function startSurreal(
  { backend = "memory", port = 18000, mem = "12g", name = "sdb-prr" }:
    { backend?: Backend; port?: number; mem?: string; name?: string } = {},
): Promise<Surreal> {
  try { execSync(`docker rm -f ${name}`, { stdio: "ignore" }); } catch {}
  let vol = "";
  const arg = backend === "memory" ? "memory" : `${backend}:/data/db.db`;
  if (backend !== "memory") {
    execSync(`rm -rf /tmp/${name} && mkdir -p /tmp/${name} && chmod 777 /tmp/${name}`);
    vol = `-v /tmp/${name}:/data`;
  }
  execSync(
    `docker run -d --name ${name} -p ${port}:8000 -m ${mem} ${vol} ` +
      `${IMAGE} start --user root --pass rootpass ${arg}`,
    { stdio: "ignore" },
  );

  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { execSync(`curl -sf -m2 ${base}/health`, { stdio: "ignore" }); up = true; break; } catch { await sleep(1000); }
  }
  if (!up) { try { execSync(`docker rm -f ${name}`, { stdio: "ignore" }); } catch {} throw new Error("SurrealDB never became healthy"); }

  const auth = "Basic " + Buffer.from("root:rootpass").toString("base64");
  const sql = async (q: string, { root = false }: { root?: boolean } = {}): Promise<Json> => {
    const headers: Record<string, string> = { "Content-Type": "text/plain", Accept: "application/json", Authorization: auth };
    if (!root) { headers["surreal-ns"] = "t"; headers["surreal-db"] = "t"; }
    const r = await fetch(`${base}/sql`, { method: "POST", headers, body: q });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return [{ status: "ERR", result: t }]; }
  };
  // namespace + database must be created explicitly, with USE NS between them
  await sql("DEFINE NAMESPACE t; USE NS t; DEFINE DATABASE t;", { root: true });

  return {
    sql,
    dockerStats: () => {
      try { return execSync(`docker stats --no-stream --format '{{.MemUsage}}' ${name}`, { encoding: "utf8" }).trim(); }
      catch { return "n/a"; }
    },
    logs: (grep = "diskann|ANNError") => {
      try { return execSync(`docker logs ${name} 2>&1 | grep -iE '${grep}' | tail -3`, { encoding: "utf8" }).trim(); }
      catch { return ""; }
    },
    stop: () => {
      try { execSync(`docker rm -f ${name}`, { stdio: "ignore" }); } catch {}
      if (vol) try { execSync(`rm -rf /tmp/${name}`); } catch {}
    },
  };
}

export const isErr = (r: Json): boolean =>
  Array.isArray(r) && r.some((x) => x && (x as { status?: string }).status === "ERR");
export const errMsg = (r: Json): string => {
  if (Array.isArray(r)) {
    const e = r.find((x) => x && (x as { status?: string }).status === "ERR") as { result?: unknown } | undefined;
    return String(e?.result ?? "");
  }
  return String(r ?? "");
};

/** INSERT vectors into `table` in HTTP-safe batches (request-size capped). */
export async function loadVectors(s: Surreal, table: string, vectors: string[], startIdx = 0): Promise<void> {
  for (let i = 0; i < vectors.length; i += 20) {
    const batch = vectors
      .slice(i, i + 20)
      .map((v, j) => `{ idx: ${startIdx + i + j}, embedding: ${v} }`)
      .join(", ");
    const r = await s.sql(`INSERT INTO ${table} [${batch}];`);
    if (isErr(r)) throw new Error(`insert failed @${startIdx + i}: ${errMsg(r).slice(0, 120)}`);
  }
}

/** Build a vector index and poll INFO FOR INDEX until it stops building. */
export async function buildIndex(
  s: Surreal, table: string, indexDef: string,
): Promise<{ status: string; buildSecs: number }> {
  const t0 = Date.now();
  await s.sql(`REMOVE INDEX IF EXISTS vidx ON ${table};`);
  await s.sql(`DEFINE INDEX vidx ON ${table} FIELDS embedding ${indexDef} CONCURRENTLY;`);
  let status = "unknown";
  for (let i = 0; i < 240; i++) {
    const info = await s.sql(`INFO FOR INDEX vidx ON ${table};`);
    const building = (info as { result?: { building?: { status?: string } } }[])[0]?.result?.building;
    status = building?.status ?? (isErr(info) ? "infoERR" : "unknown");
    if (status === "ready" || status === "error" || status === "infoERR") break;
    await sleep(2000);
  }
  return { status, buildSecs: +((Date.now() - t0) / 1000).toFixed(1) };
}

/** Run `n` KNN queries; return ok/fail counts. */
export async function knnProbe(
  s: Surreal, table: string, vectors: string[], n = 20,
): Promise<{ ok: number; fail: number; lastError: string }> {
  let ok = 0, fail = 0, lastError = "";
  for (let i = 0; i < n; i++) {
    const q = vectors[(i * 9973) % vectors.length];
    const r = await s.sql(`SELECT idx FROM ${table} WHERE embedding <|20,64|> ${q};`);
    if (isErr(r)) { fail++; lastError = errMsg(r).slice(0, 160); }
    else if (((r as { result?: unknown[] }[])[0]?.result?.length ?? 0) > 0) ok++;
    else { fail++; lastError = "empty result"; }
  }
  return { ok, fail, lastError };
}
