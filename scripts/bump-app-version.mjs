import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInlineAppUpdateSnippet,
  buildAppAssetInlineFixSnippet,
  buildBootDismissSnippet,
  buildPerformanceHintsSnippet,
  APP_ASSET_FIX_MARKER,
  BOOT_DISMISS_MARKER,
  CRITICAL_SHELL_STYLE_TAG,
  PERFORMANCE_HINTS_MARKER
} from "./inline-app-update-snippet.mjs";

const CRITICAL_SHELL_MARKER = "<!-- han-pit-critical-shell -->";
const BOOT_DISMISS_END = "<!-- /han-pit-boot-dismiss -->";
const ASSET_FIX_END = "<!-- /han-pit-asset-fix -->";
const assetFixSnippet = buildAppAssetInlineFixSnippet();
const bootDismissSnippet = buildBootDismissSnippet();

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

const PAGE_MODULE_ENTRY = {
  "index.html": "index.js",
  "hub.html": "hub.js",
  "layout.html": "layout.js",
  "global-layout.html": "global-layout.js",
  "login.html": "login.js"
};

const htmlFiles = readdirSync(root).filter((name) => name.endsWith(".html"));
for (const name of htmlFiles) {
  const path = join(root, name);
  let html = readFileSync(path, "utf8");
  const perfHints = buildPerformanceHintsSnippet(v, PAGE_MODULE_ENTRY[name] || "");
  if (html.includes(PERFORMANCE_HINTS_MARKER)) {
    html = html.replace(
      new RegExp(`${PERFORMANCE_HINTS_MARKER}[\\s\\S]*?<!-- /han-pit-perf-hints -->`, "m"),
      perfHints
    );
  } else if (html.includes('name="han-pit-build"')) {
    html = html.replace(
      /<meta\s+name="han-pit-build"\s+content="[^"]*"\s*\/?>/,
      `<meta name="han-pit-build" content="${v}" />\n  ${perfHints}`
    );
  }
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
  if (html.includes(CRITICAL_SHELL_MARKER)) {
    html = html.replace(
      new RegExp(`${CRITICAL_SHELL_MARKER}[\\s\\S]*?<!-- /han-pit-critical-shell -->`, "m"),
      `${CRITICAL_SHELL_MARKER}\n  ${CRITICAL_SHELL_STYLE_TAG}\n  <!-- /han-pit-critical-shell -->`
    );
  } else if (html.includes(INLINE_MARKER_END)) {
    html = html.replace(
      INLINE_MARKER_END,
      `${INLINE_MARKER_END}\n  ${CRITICAL_SHELL_MARKER}\n  ${CRITICAL_SHELL_STYLE_TAG}\n  <!-- /han-pit-critical-shell -->`
    );
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>\n  ${CRITICAL_SHELL_MARKER}\n  ${CRITICAL_SHELL_STYLE_TAG}\n  <!-- /han-pit-critical-shell -->`
    );
  }
  if (html.includes(APP_ASSET_FIX_MARKER)) {
    html = html.replace(
      new RegExp(`${APP_ASSET_FIX_MARKER}[\\s\\S]*?${ASSET_FIX_END}`, "m"),
      `${APP_ASSET_FIX_MARKER}\n  ${assetFixSnippet}\n  ${ASSET_FIX_END}`
    );
  } else if (html.includes("<!-- /han-pit-critical-shell -->")) {
    html = html.replace(
      "<!-- /han-pit-critical-shell -->",
      `<!-- /han-pit-critical-shell -->\n  ${APP_ASSET_FIX_MARKER}\n  ${assetFixSnippet}\n  ${ASSET_FIX_END}`
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
  html = html.replace(
    /<link\s+rel="manifest"\s+href="\.\/manifest\.json(?:\?v=[^"]*)?"/g,
    `<link rel="manifest" href="./manifest.json?v=${v}"`
  );
  html = html.replace(
    /<div class="page-boot-loading"[\s\S]*?<\/div>\s*/g,
    ""
  );
  if (html.includes(BOOT_DISMISS_MARKER)) {
    html = html.replace(
      new RegExp(`${BOOT_DISMISS_MARKER}[\\s\\S]*?${BOOT_DISMISS_END}`, "m"),
      bootDismissSnippet
    );
  } else if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>\n  ${bootDismissSnippet}`);
  }
  writeFileSync(path, html, "utf8");
}

const manifestPath = join(root, "manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.start_url = `./login.html?_hanpit_v=${v}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
} catch {
  /* ignore */
}

console.log(`app-version.json v=${v}, SW_DEPLOY_REVISION=${nextRev}, html=${htmlFiles.length}`);
