#!/usr/bin/env node
/**
 * 모든 .js 파일에 대해 `node --check` (node_modules 제외).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      if (ent.name.startsWith(".")) continue;
      walk(p, out);
    } else if (ent.isFile() && ent.name.endsWith(".js")) {
      out.push(p);
    }
  }
}

const files = [];
walk(root, files);
files.sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error("FAIL:", f);
    failed = 1;
  }
}

if (!failed) {
  console.log(`OK: ${files.length} JS file(s) passed node --check`);
}
process.exit(failed);
