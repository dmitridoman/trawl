#!/usr/bin/env node
// Refreshes the vendored passive-recon datasets used by src/tech.ts and src/cve.ts:
//   - src/data/fingerprints.json  — merged Wappalyzer-style technology fingerprints
//     (from the community-maintained enthec/webappanalyzer fork; the official
//     Wappalyzer client went proprietary in 2023 but the fingerprint DB stays open)
//   - src/data/categories.json    — fingerprint category id -> { name, groups }
//   - src/data/jsrepository.json  — RetireJS known-vulnerable JS library dataset
//
// Run: node scripts/update-datasets.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "src", "data");

const WAA = "https://raw.githubusercontent.com/enthec/webappanalyzer/main/src";
const RETIRE = "https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository.json";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Technologies are sharded across _.json + a.json .. z.json. Merge into one map.
  const shards = ["_", ..."abcdefghijklmnopqrstuvwxyz".split("")];
  const technologies = {};
  for (const shard of shards) {
    const part = await getJson(`${WAA}/technologies/${shard}.json`);
    Object.assign(technologies, part);
    process.stdout.write(`  fingerprints/${shard}.json (${Object.keys(part).length})\n`);
  }
  fs.writeFileSync(path.join(DATA_DIR, "fingerprints.json"), JSON.stringify(technologies));
  console.log(`fingerprints.json — ${Object.keys(technologies).length} technologies`);

  const categories = await getJson(`${WAA}/categories.json`);
  fs.writeFileSync(path.join(DATA_DIR, "categories.json"), JSON.stringify(categories));
  console.log(`categories.json — ${Object.keys(categories).length} categories`);

  const retire = await getJson(RETIRE);
  fs.writeFileSync(path.join(DATA_DIR, "jsrepository.json"), JSON.stringify(retire));
  console.log(`jsrepository.json — ${Object.keys(retire).length} libraries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
