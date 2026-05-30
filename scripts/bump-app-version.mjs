import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInlineAppUpdateSnippet } from "./inline-app-update-snippet.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const inlineSnippet = buildInlineAppUpdateSnippet(v);
const INLINE_MARKER_START = "<!-- han-pit-inline-update -->";
const INLINE_MARKER_END = "<!-- /han-pit-inline-update -->";

writeFileSync(join(root, "app-version.json"), `${JSON.stringify({ v }, null, 2)}\n`, "utf8");

const swPath = join(root, "firebase-messaging-sw.js");
let sw = readFileSync(swPath, "utf8");
const m = sw.match(/const SW_DEPLOY_REVISION = (\d+)/);
const nextRev = m ? Number(m[1]) + 1 : 1;
sw = sw.replace(/const SW_DEPLOY_REVISION = \d+/, `const SW_DEPLOY_REVISION = ${nextRev}`);
writeFileSync(swPath, sw, "utf8");

const htmlFiles = readdirSync(root).filter((name) => name.endsWith(".html"));
for (const name of htmlFiles) {
  const path = join(root, name);
  let html = readFileSync(path, "utf8");
  if (html.includes(INLINE_MARKER_START)) {
    const re = new RegExp(
      `${INLINE_MARKER_START}[\\s\\S]*?${INLINE_MARKER_END}`,
      "m"
    );
    html = html.replace(re, `${INLINE_MARKER_START}\n${inlineSnippet}\n  ${INLINE_MARKER_END}`);
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  ${INLINE_MARKER_START}\n${inlineSnippet}\n  ${INLINE_MARKER_END}`
    );
  }
  if (html.includes('name="han-pit-build"')) {
    html = html.replace(
      /<meta\s+name="han-pit-build"\s+content="[^"]*"\s*\/?>/,
      `<meta name="han-pit-build" content="${v}" />`
    );
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  <meta name="han-pit-build" content="${v}" />`
    );
  }
  html = html.replace(
    /(<script\s+type="module"\s+src="\.\/js\/[^"]+\.js)\?v=[^"]*(")/g,
    `$1?v=${v}$2`
  );
  html = html.replace(
    /(<link\s+rel="stylesheet"\s+href="\.\/css\/[^"]+\.css)\?v=[^"]*(")/g,
    `$1?v=${v}$2`
  );
  html = html.replace(
    /(<link\s+rel="stylesheet"\s+href="\.\/css\/[^"]+\.css)(")/g,
    `$1?v=${v}$2`
  );
  writeFileSync(path, html, "utf8");
}

const manifestPath = join(root, "manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.start_url = `./hub.html?_hanpit_v=${v}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
} catch {
  /* ignore */
}

console.log(`app-version.json v=${v}, SW_DEPLOY_REVISION=${nextRev}, html=${htmlFiles.length}`);
