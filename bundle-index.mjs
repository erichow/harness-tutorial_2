#!/usr/bin/env node
/**
 * bundle-index.mjs — Generate part1-harness.html (chapters 1-22)
 * 
 * Takes the base bundled file (harness-backup.html) and produces
 * part1-harness.html with updated metadata for the ch1-22 tutorial.
 *
 * The base file already contains all ch1-22 content; this script
 * ensures the title/SVG reflect the "Part 1" naming.
 *
 * Usage: node bundle-index.mjs
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

const BASE_SOURCE = "../harness/harness-backup.html";
const OUTPUT = "part1-harness.html";

function gz(str) { return gzipSync(Buffer.from(str)).toString("base64"); }
function ungz(b64) { return gunzipSync(Buffer.from(b64, "base64")).toString(); }

function lastScriptBlock(html, type) {
  const m = `type="${type}"`;
  const i = html.lastIndexOf(m); if (i === -1) return null;
  const o = html.indexOf(">", i) + 1;
  const c = html.indexOf("</script>", o);
  return c === -1 ? null : { body: html.slice(o, c), start: o, end: c };
}

// ── 1. Read base file ────────────────────────────────────────────────
let baseHtml;
try {
  baseHtml = readFileSync(BASE_SOURCE, "utf-8");
  console.log(`📖 Base: ${BASE_SOURCE} (${(Buffer.byteLength(baseHtml)/1024/1024).toFixed(1)}MB)`);
} catch {
  // Fallback: current file itself is the base
  baseHtml = readFileSync(OUTPUT, "utf-8");
  console.log(`📖 Base: ${OUTPUT} (self, ${(Buffer.byteLength(baseHtml)/1024/1024).toFixed(1)}MB)`);
}

// ── 2. Parse manifest ────────────────────────────────────────────────
const mb = lastScriptBlock(baseHtml, "__bundler/manifest");
const tb = lastScriptBlock(baseHtml, "__bundler/template");
if (!mb || !tb) throw Error("Missing manifest or template in base file");

const manifest = JSON.parse(mb.body);
let templateStr = JSON.parse(tb.body);

console.log(`📦 Manifest: ${Object.keys(manifest).length} entries`);

// ── 3. Verify ch1-22 are present ─────────────────────────────────────
const DATA_UUID = "8d7a4ac8-966c-46b7-b06b-7360233a148f";
const dataContent = ungz(manifest[DATA_UUID].data);

const hasCh1 = dataContent.includes('id: "ch1"');
const hasCh22 = dataContent.includes('id: "ch22"');
console.log(`🔍 ch1-22: ${hasCh1 && hasCh22 ? '✅ present' : '❌ missing/incomplete'}`);

if (!hasCh1 || !hasCh22) {
  console.log("⚠️  Chapters 1-22 incomplete — consider using a full base file.");
}

// ── 4. Reassemble (no body modifications — use original html) ─────────
const title = "构建 AI Agent Harness · 可视化学习教程 · 第 1-22 章";
const newManifestJson = JSON.stringify(manifest);
const newTemplateJson = JSON.stringify(templateStr).replace(/<\//g, "<\\u002F");

let newHtml =
  baseHtml.slice(0, mb.start) + newManifestJson +
  baseHtml.slice(mb.end, tb.start) + newTemplateJson +
  baseHtml.slice(tb.end);

// ── 5. Update metadata in final output ───────────────────────────────
// Do this AFTER reassembly to avoid offset skew
newHtml = newHtml.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
newHtml = newHtml.replace(
  /(<text[^>]*>)\s*Harness → 产品\s*(<\/text>)/,
  `$1Harness 教程$2`
);
newHtml = newHtml.replace(
  /(<text[^>]*>)\s*Harness 教程\s*(<\/text>)/,
  `$1Harness 教程$2`
);

writeFileSync(OUTPUT, newHtml, "utf-8");
console.log(`✅ ${OUTPUT} written (${(Buffer.byteLength(newHtml)/1024/1024).toFixed(1)}MB)`);

// Simple verification via grep
const v = readFileSync(OUTPUT, "utf-8");
const t = v.match(/<title>([^<]+)<\/title>/);
console.log(`   Title: ${t ? t[1] : 'NOT FOUND'}`);
console.log(`   Size:  ${(Buffer.byteLength(v)/1024/1024).toFixed(1)}MB`);
