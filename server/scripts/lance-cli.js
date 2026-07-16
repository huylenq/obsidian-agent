#!/usr/bin/env node
// CLI for the vault's LanceDB index — same code path as the Hermes bridge.
// `reindex` performs a real (incremental) build, not a dry run.
//
// Usage:
//   node scripts/lance-cli.js status
//   node scripts/lance-cli.js search "query text" [limit]
//   node scripts/lance-cli.js by-path "relative/path.md" [limit]
//   node scripts/lance-cli.js peek [n]              # show n raw rows
//   node scripts/lance-cli.js paths [n]             # list indexed paths
//   node scripts/lance-cli.js reindex               # incremental real index build
//
// Vault defaults to ~/lifeos. Override with VAULT=/path env var.

import { join } from "path";
import { homedir } from "os";
import {
  connect,
  getOrCreateTable,
  searchByVector,
  searchByPath,
  countDocs,
  getIndexedMtimes,
} from "../embeddings/lanceIndex.js";
import { embedTexts } from "../embeddings/embed.js";
import { buildIndex } from "../embeddings/indexer.js";

const VAULT = process.env.VAULT || join(homedir(), "lifeos");
const DB_PATH = join(VAULT, ".obsidian", "lance");

async function openTable() {
  const db = await connect(DB_PATH);
  return getOrCreateTable(db);
}

const cmd = process.argv[2] || "status";
const args = process.argv.slice(3);

try {
  if (cmd === "status") {
    const table = await openTable();
    const count = await countDocs(table);
    const mtimes = await getIndexedMtimes(table);
    console.log("Vault:", VAULT);
    console.log("DB:", DB_PATH);
    console.log("Total chunks:", count);
    console.log("Indexed files:", mtimes.size);
  } else if (cmd === "peek") {
    const table = await openTable();
    const n = parseInt(args[0]) || 3;
    const rows = await table.query().limit(n).toArray();
    for (const r of rows) {
      console.log({
        id: r.id,
        path: r.path,
        title: r.title,
        chunkIndex: r.chunkIndex,
        mtime: r.mtime,
        contentPreview: (r.content || "").slice(0, 100),
        vectorLen: r.vector?.length,
        vectorHead: Array.from(r.vector || []).slice(0, 3),
      });
    }
  } else if (cmd === "paths") {
    const table = await openTable();
    const n = parseInt(args[0]) || 50;
    const mtimes = await getIndexedMtimes(table);
    const list = Array.from(mtimes.entries()).slice(0, n);
    for (const [p, m] of list) console.log(new Date(m).toISOString(), p);
    console.log(`(${mtimes.size} total)`);
  } else if (cmd === "search") {
    const text = args[0];
    const limit = parseInt(args[1]) || 10;
    if (!text) throw new Error("usage: search <text> [limit]");
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    const table = await openTable();
    const [vec] = await embedTexts([text]);
    const results = await searchByVector(table, vec, { limit, minSimilarity: 0 });
    for (const r of results) {
      console.log(r.similarity.toFixed(3), r.path, "—", r.title);
    }
  } else if (cmd === "by-path") {
    const path = args[0];
    const limit = parseInt(args[1]) || 10;
    if (!path) throw new Error("usage: by-path <relpath> [limit]");
    const table = await openTable();
    const results = await searchByPath(table, path, { limit, minSimilarity: 0 });
    if (!results) {
      console.log("Path not in index:", path);
    } else {
      for (const r of results) {
        console.log(r.similarity.toFixed(3), r.path, "—", r.title);
      }
    }
  } else if (cmd === "reindex") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    const table = await openTable();
    const result = await buildIndex(VAULT, table);
    console.log("Done:", result);
  } else {
    console.error("Unknown command:", cmd);
    process.exit(1);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
}
