#!/usr/bin/env node
/**
 * bundle-index2.mjs — Create part2-product.html from part1-harness.html + ch23-32 content
 * 
 * 1. Copies the base framework (React, CSS, components, diagrams)
 * 2. Replaces data with ch23-32 only
 * 3. Replaces app to render only ch23-32
 * 4. Removes ch1-22, FAQ, references, summaries entries
 * 5. Adds ch23-32 chapter entries
 * 6. Updates template script tags
 * 7. Updates HTML title and SVG
 *
 * Usage: node bundle-index2.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

const TUTORIAL_DIR = "tutorial_content";

function gz(str) { return gzipSync(Buffer.from(str)).toString("base64"); }
function ungz(b64) { return gunzipSync(Buffer.from(b64, "base64")).toString(); }

function lastScriptBlock(html, type) {
  const m = `type="${type}"`;
  const i = html.lastIndexOf(m); if (i === -1) return null;
  const o = html.indexOf(">", i) + 1;
  const c = html.indexOf("</script>", o);
  return c === -1 ? null : { body: html.slice(o, c), start: o, end: c };
}

// ── 1. Read base HTML ────────────────────────────────────────────────
const html = readFileSync("part1-harness.html", "utf-8");
console.log(`📖 Base: part1-harness.html (${(Buffer.byteLength(html)/1024/1024).toFixed(1)}MB)`);

// ── 2. Parse manifest & template ─────────────────────────────────────
const mb = lastScriptBlock(html, "__bundler/manifest");
if (!mb) throw Error("No manifest found");
const tb = lastScriptBlock(html, "__bundler/template");
if (!tb) throw Error("No template found");

const manifest = JSON.parse(mb.body);
const templateStr = JSON.parse(tb.body);
console.log(`📦 Manifest: ${Object.keys(manifest).length} entries`);

// ── 3. Known UUIDs (from framework) ──────────────────────────────────
const FRAMEWORK_UUIDS = [
  "5aa20dfe-887e-4bcd-ab8e-252a643e432a",  // React/ReactDOM
  "9f9c8e00-d669-4714-98f2-3c4a524eb6e4",  // React/ReactDOM
  "fc686abf-6ca3-4d4f-bac4-51ca58075e75",  // Babel standalone
  "71d11c4c-db11-43b8-8f83-2ff2a465e4e8",  // tutorial-components
  "361aef0b-a414-43a2-9cd4-88b8b52a8255",  // tutorial-diagrams
];

const DATA_UUID = "8d7a4ac8-966c-46b7-b06b-7360233a148f";  // tutorial-data
const APP_UUID = "9173a2be-f606-4b53-a4a5-553e1e851b7e";    // tutorial-app
const SUMMARIES_UUID = "543344d7-9dc1-492b-a9bf-dd0d82e47233"; // chapter-summaries

// Ch1-22 UUIDs (to remove)
const CHAPTER_OLD = [
  "8c6308f0-31e3-4aeb-a33b-ea871d9e5e38",  // ch1
  "2d41d84f-6e6b-458a-bd53-007d6ddc8102",  // ch2
  "556be138-f43c-48f7-941b-3598ebaf7d82",  // ch3
  "3e0fbb87-e811-4230-be0f-eb95c6817de8",  // ch4
  "e483289b-3631-4c68-b2ad-ed28f58234b2",  // ch5
  "3789fe32-e6da-4471-ac39-885174e3f212",  // ch6
  "7d061b39-365e-4792-a756-56cc57ff36d3",  // ch7
  "4a39a727-0de2-4fdb-8eef-b2e2ab10da28",  // ch8
  "017775f9-6ed2-4c7d-a9b2-536fa4229634",  // ch9
  "e993cf85-0d14-48a0-8418-3d1f110eb1f7",  // ch10
  "b37deb55-f218-43e5-84bf-9d911a5cd5a0",  // ch11
  "2a760ed6-8df8-464c-9c73-5bb9537f4ee0",  // ch12
  "a27b5abe-654c-430b-8b32-76c7f2b19809",  // ch13
  "20d88b10-19b9-47b8-8e00-1953d92ed723",  // ch14
  "74f19172-bd52-4d2a-bfda-4ad816c2693a",  // ch15
  "f1662dbe-0aaf-4b42-b149-ebc801d43451",  // ch16
  "6e6b2230-6f37-42cd-b3d2-7ec105b76fea",  // ch17
  "28a8f830-9777-4f5a-85e8-8f2029a94efd",  // ch18
  "6b385a79-a8a5-4ac9-922e-78221eecf6c4",  // ch19
  "561ee515-add9-42c4-a010-ffc291ab53a6",  // ch20
  "50c3e3d0-3579-4e27-a6db-a14d7cb15732",  // ch21
  "e1d37681-1c4b-4979-822d-e5c938316683",  // ch22
  "a5bc299c-f392-497b-b2bc-ff65125a5d10",  // FAQ
];

// What to keep in manifest
const KEEP_UUIDS = new Set([
  ...FRAMEWORK_UUIDS,
  DATA_UUID,
  APP_UUID,
  SUMMARIES_UUID,
]);

// ── 4. Build new data file (ch23-32 only) ────────────────────────────
const NEW_CHAPTERS = [
  { id: "ch23", num: 23, title: "从 Harness 到产品",        titleEn: "From Harness to Application",           full: true,  section: "I · 框架整合" },
  { id: "ch24", num: 24, title: "文件系统工具完整化",       titleEn: "Completing the File Tool Suite",        full: true,  section: "I · 框架整合" },
  { id: "ch25", num: 25, title: "终端执行器",               titleEn: "Terminal Execution",                    full: true,  section: "II · 开发工具链" },
  { id: "ch26", num: 26, title: "Git 工具集",               titleEn: "Git Tool Integration",                  full: true,  section: "II · 开发工具链" },
  { id: "ch27", num: 27, title: "语言服务器协议",           titleEn: "Language Server Protocol",              full: true,  section: "II · 开发工具链" },
  { id: "ch28", num: 28, title: "代码分析与项目理解",        titleEn: "Code Analysis & Project Understanding", full: true,  section: "II · 开发工具链" },
  { id: "ch29", num: 29, title: "用户界面与交互层",         titleEn: "UI & Interaction",                      full: true,  section: "III · 产品化" },
  { id: "ch30", num: 30, title: "配置系统",                titleEn: "Configuration System",                  full: true,  section: "III · 产品化" },
  { id: "ch31", num: 31, title: "评测你自己的 Agent",      titleEn: "Eval for Your Agent",                   full: true,  section: "III · 产品化" },
  { id: "ch32", num: 32, title: "你的第一个 Coding Agent", titleEn: "Your First Coding Agent",               full: true,  section: "III · 产品化" },
];

// Keep full GLOSSARY (used by Term component)
// Keep PREREQUISITES but only ch23-32 entries
const NEW_PREREQUISITES = {
  ch23: { recommended: [2, 4, 5, 6] },
  ch24: { recommended: [4, 6, 11, 23] },
  ch25: { recommended: [4, 6, 14, 23] },
  ch26: { recommended: [4, 23, 25] },
  ch27: { recommended: [13, 24, 25] },
  ch28: { recommended: [7, 8, 10, 24] },
  ch29: { recommended: [5, 6, 18, 23] },
  ch30: { recommended: [23] },
  ch31: { recommended: [19, 24, 25, 26] },
  ch32: { recommended: [23, 24, 25, 26, 27, 28, 29, 30, 31] },
};

// Read existing data to get GLOSSARY
const oldData = ungz(manifest[DATA_UUID].data);

// Extract GLOSSARY from old data
const glossaryMatch = oldData.match(/const GLOSSARY = (\{[\s\S]*?^\});/m);
if (!glossaryMatch) throw Error("Cannot find GLOSSARY in data");
const glossaryStr = glossaryMatch[1];

const newData = `/* tutorial-data.jsx — Chapter metadata, glossary, quiz data */

const CHAPTERS = ${JSON.stringify(NEW_CHAPTERS, null, 2)};

/* Glossary — terms with definitions, hovered via <Term> component. */
const GLOSSARY = ${glossaryStr};

const PREREQUISITES = ${JSON.stringify(NEW_PREREQUISITES, null, 2)};

window.CHAPTERS = CHAPTERS;
window.GLOSSARY = GLOSSARY;
window.PREREQUISITES = PREREQUISITES;
`;

manifest[DATA_UUID].data = gz(newData);
console.log("✅ tutorial-data updated (ch23-32 only).");

// ── 5. Build new app (render ch23-32 only) ───────────────────────────
const oldApp = ungz(manifest[APP_UUID].data);

// Replace chapter rendering section
// In the old app, find the rendering block that has <Chapter1 />...<ChapterFAQ />
// We need to replace the entire block from <Chapter1 /> to <References /> section
const appStartMarker = "<Chapter1 />";
const appEndMarker = "      </main>";
const appStartIdx = oldApp.indexOf(appStartMarker);
const appEndIdx = oldApp.lastIndexOf(appEndMarker);
if (appStartIdx === -1 || appEndIdx === -1) throw Error("Cannot find chapter rendering section");

const beforeChapters = oldApp.slice(0, appStartIdx);

// Replace the cover/intro section (originally for ch1-22) with ch23-32 content
let intro = beforeChapters;

// All replacements: use simple text anchors, not HTML attributes

// Cover title
intro = intro.replace(
  `构建 AI Agent<br />Harness 教程`,
  `从 Harness 到产品<br />构建你的 Coding Agent`
);

// Subtitle
intro = intro.replace(
  `从零开始 · 22 章 · 一份可视化学习指南`,
  `第 23-32 章 · 从框架到产品的 10 步路线图`
);

// Description paragraph - use the unique text anchor
intro = intro.replace(
  `这本书的中心论点：模型（Claude、GPT 等等）是容易的部分；难的是围绕模型的<strong>一切</strong>——
            循环、协议、上下文、工具、可观测性、持久化。<em>那一切有个名字，叫 harness。</em>`,
  `前 22 章造了一个通用 agent harness——Provider 协议、ToolRegistry、Compactor、PermissionManager……每一个都是解耦的、可测试的、与具体产品无关的。<br /><br />
        从第 23 章开始，我们要掉头了：<strong>在 harness 之上建一个具体的产品。</strong>
        一个能在终端里跑、能读文件、能执行命令、能提交 Git、能和用户对话的 coding agent。`
);

// Callout - "怎么用这份教程" title
intro = intro.replace(
  `title="怎么用这份教程"`,
  `title="关于 ch23-32"`
);
// Replace the callout list items
intro = intro.replace(
  `<li>从左侧目录跳转任何一章；带 <strong>✓</strong> 的是你读完的；右侧数字是阅读时间估算</li>
              <li>每章末有<strong>上一章 / 下一章</strong>按钮可顺序阅读</li>
              <li>大屏右侧浮现<strong>本章小节</strong>导航，跟随滚动高亮当前小节</li>
              <li>右下角浮动按钮：<strong>笔记本</strong>（可导出 Markdown）· 字号 · 深浅色 · 代码显隐</li>
              <li>正文里带<Term k="Agent">下划线</Term>的词可以悬停查看术语定义</li>
              <li>每章末有自测题——选择会保存到本地</li>`,
  `<li>这 10 章假定你已经理解 Harness 的核心概念（循环、工具、上下文）</li>
              <li>每章都会交付一段可运行的代码——从 CLI 入口到完整 coding agent</li>
              <li>ch23 搭建骨架，ch24-28 填充工具链，ch29-32 打磨为产品</li>
              <li>大屏右侧有<strong>本章小节</strong>导航，底部有上一章/下一章按钮</li>`
);

// "22 章的全景图" heading + MindmapDiagram
intro = intro.replace(
  `22 章的全景图`,
  `从 Harness 到产品：10 章路线图`
);
intro = intro.replace(
  `<MindmapDiagram />\n          <Divider />`,
  `<p style={{ fontFamily: "var(--font-hand)", fontSize: "1.05em", color: "var(--ink-soft)", maxWidth: 720, lineHeight: 1.6, marginTop: 12 }}>
            <strong>第一部 · 框架整合（ch23-24）</strong> — 在 Harness 上搭建 CLI 入口，补全文件工具集<br />
            <strong>第二部 · 开发工具链（ch25-28）</strong> — 终端执行器、Git、LSP、代码分析<br />
            <strong>第三部 · 产品化（ch29-32）</strong> — UI/交互、配置、评测、交付你的第一个 Coding Agent
          </p>\n          <Divider />`
);

// Sidebar title
intro = intro.replace(
  `AI Agent<br />Harness`,
  `从 Harness<br />到产品`
);

// Sidebar subtitle
intro = intro.replace(
  `22 章 · 可视化学习教程`,
  `第 23-32 章 · 从 Harness 到产品`
);

// Sidebar progress counter
intro = intro.replace(
  `{completed.size} / 22 章`,
  `{completed.size} / 10 章`
);

// Sidebar credit line
intro = intro.replace(
  `✏ 全 22 章完整版`,
  `✏ ch23-32 · 从框架到应用`
);

const afterMain = oldApp.slice(appEndIdx + "      </main>".length);

// Build new chapter rendering:
// - Render ch23-32 chapters
// - No FAQ or References sections
// - A closing "读完了" (finished) section customized for ch23-32
const newChapterSection = `      {/* ─── Section VIII: 从框架到应用 ─── */}
      <Chapter23 />
      <Chapter24 />
      <Chapter25 />
      <Chapter26 />
      <Chapter27 />
      <Chapter28 />
      <Chapter29 />
      <Chapter30 />
      <Chapter31 />
      <Chapter32 />

      {/* End */}
      <section className="chapter" id="end">
        <h2 className="chapter-title">
          <span className="ch-num">★</span>
          读完了
        </h2>
        <p className="chapter-meta">从 Harness 到你的第一个 Coding Agent</p>
        <div className="lead">
          如果你跟着 ch23-32 把代码敲完了，你已经：
        </div>
        <ul style={{ fontFamily: "var(--font-hand)", fontSize: "1.05em", lineHeight: 1.7 }}>
          <li>在 Harness 框架之上组装了一个真正的 CLI coding agent</li>
          <li>实现了完整的文件系统工具集：读、写、编辑、搜索</li>
          <li>集成了终端执行器，能运行命令并捕获输出</li>
          <li>接入了 Git 工具集，支持自动 commit、diff、日志</li>
          <li>通过 LSP 协议实现了代码理解和跳转</li>
          <li>构建了代码分析与项目理解能力</li>
          <li>设计了终端用户界面与交互反馈层</li>
          <li>建立了可配置的系统架构</li>
          <li>编写了评测流水线来验证 agent 的表现</li>
          <li>交付了你的第一个生产级 coding agent</li>
        </ul>
        <p style={{ fontFamily: "var(--font-hand)", fontSize: "1.05em", marginTop: 16 }}>
          前 22 章给了你引擎；ch23-32 给了你方向盘和车轮。<br />
          现在——去造你的 Agent 吧 🚀
        </p>
      </section>
      </main>
`;

const newApp = intro + newChapterSection + afterMain;
manifest[APP_UUID].data = gz(newApp);
console.log("✅ tutorial-app updated (renders ch23-32 only).");

// ── 6. Update summaries (empty, since they referenced ch4-22) ────────
const newSummaries = `/* tutorial-chapter-summaries.jsx — Concise visual cards for chapters 23-32 */

const CHAPTER_SUMMARIES = {};

if (typeof window !== "undefined") window.CHAPTER_SUMMARIES = CHAPTER_SUMMARIES;
`;
manifest[SUMMARIES_UUID].data = gz(newSummaries);
console.log("✅ chapter-summaries emptied (ch23-32 summaries not generated).");

// ── 7. Remove old chapter entries from manifest ──────────────────────
for (const uuid of CHAPTER_OLD) {
  delete manifest[uuid];
}
console.log(`🗑️  Removed ${CHAPTER_OLD.length} old entries (ch1-22 + FAQ).`);

// ── 8. Add ch23-32 chapter entries to manifest ───────────────────────
const tbBody = JSON.parse(tb.body);
const existingRefs = new Set([...tbBody.matchAll(/src="([a-f0-9-]+)"/g)].map(m => m[1]));

const newUuids = [];
for (let ch = 23; ch <= 32; ch++) {
  const content = readFileSync(`${TUTORIAL_DIR}/tutorial-chapter${ch}.txt`, "utf-8");
  const b64 = gz(content);
  // Check for duplicate content
  let dup = null;
  for (const [u, e] of Object.entries(manifest))
    if (e.mime === "text/javascript" && e.compressed && e.data === b64) { dup = u; break; }
  const uuid = dup || randomUUID();
  if (!dup) manifest[uuid] = { mime: "text/javascript", compressed: true, data: b64 };
  newUuids.push(uuid);
  console.log(`  ${dup ? "⏭️" : "✅"} ch${ch} -> ${uuid.slice(0, 8)}…`);
}

// ── 9. Update template script tags ───────────────────────────────────
// Build new template: keep framework scripts, remove old chapter scripts, add new ones
// Framework scripts (non-babel)
const frameworkScripts = [
  '<script src="5aa20dfe-887e-4bcd-ab8e-252a643e432a"></script>',
  '<script src="9f9c8e00-d669-4714-98f2-3c4a524eb6e4"></script>',
  '<script src="fc686abf-6ca3-4d4f-bac4-51ca58075e75"></script>',
];

// Fixed-order babel scripts: data, components, diagrams, chapters, app
const babelScripts = [
  `<script type="text/babel" src="${DATA_UUID}"></script>`,
  `<script type="text/babel" src="71d11c4c-db11-43b8-8f83-2ff2a465e4e8"></script>`,
  `<script type="text/babel" src="361aef0b-a414-43a2-9cd4-88b8b52a8255"></script>`,
  ...newUuids.map(u => `<script type="text/babel" src="${u}"></script>`),
  `<script type="text/babel" src="${SUMMARIES_UUID}"></script>`,
  `<script type="text/babel" src="${APP_UUID}"></script>`,
];

// We need to find and replace the template body
// The template is a JSON string of the full HTML
// We need to replace the script section
// Strategy: find the existing babel scripts block and replace it

// Find the babel script section in template
const babelStart = tbBody.indexOf('<script type="text/babel"');
const babelEnd = tbBody.lastIndexOf('</script>', tbBody.lastIndexOf('</body>'));
// Go to the last regular script + find the first babel script
const firstBabelIdx = tbBody.indexOf('<script type="text/babel"');
const lastRegularIdx = tbBody.lastIndexOf('</script>', firstBabelIdx) + '</script>'.length;

const newBabelBlock = babelScripts.join("\n");

const newTemplateBody = 
  tbBody.slice(0, firstBabelIdx) + newBabelBlock + "\n\n" + tbBody.slice(babelEnd + '</script>'.length);

// ── 10. Update HTML metadata ─────────────────────────────────────────
// Title
const newTitle = "从 Harness 到产品 · 构建你的 Coding Agent · 第 23-32 章";

// Update SVG thumbnail text
const oldSvgText = 'Harness 教程';
const newSvgText = 'Harness → 产品';

const newTemplateBody2 = newTemplateBody
  .replace(/<title>.*?<\/title>/, `<title>${newTitle}</title>`)
  .replace(oldSvgText, newSvgText);

// ── 11. Reassemble ───────────────────────────────────────────────────
const newManifestJson = JSON.stringify(manifest);
let newTemplateJson = JSON.stringify(newTemplateBody2);
newTemplateJson = newTemplateJson.replace(/<\//g, "<\\u002F");

let newHtml =
  html.slice(0, mb.start) + newManifestJson +
  html.slice(mb.end, tb.start) + newTemplateJson +
  html.slice(tb.end);

// ── 12. Update HTML title and SVG in final output ────────────────────
// Do this AFTER reassembly to avoid offset skew from length changes
newHtml = newHtml.replace(
  /<title>.*?<\/title>/,
  `<title>${newTitle}</title>`
);

// Update SVG thumbnail text (in the <div id="__bundler_thumbnail">)
newHtml = newHtml.replace(
  /(<text[^>]*>)\s*Harness 教程\s*(<\/text>)/,
  `$1Harness → 产品$2`
);

writeFileSync("part2-product.html", newHtml, "utf-8");
console.log(`\n✅ part2-product.html written (${(Buffer.byteLength(newHtml)/1024/1024).toFixed(1)}MB)`);

// ── 12. Verify ───────────────────────────────────────────────────────
const v = readFileSync("part2-product.html", "utf-8");
const vm = JSON.parse(lastScriptBlock(v, "__bundler/manifest").body);
const vt = JSON.parse(lastScriptBlock(v, "__bundler/template").body);
const vs = [...vt.matchAll(/src="([a-f0-9-]+)"/g)].map(m => m[1]);

console.log(`\n🔍 Verification:`);
console.log(`  Manifest: ${Object.keys(vm).length} entries (was ${Object.keys(manifest).length})`);
console.log(`  Template: ${vs.length} script refs`);
console.log(`  Data has ch23: ${ungz(vm[DATA_UUID].data).includes('"ch23"')}`);
console.log(`  App has ch23: ${ungz(vm[APP_UUID].data).includes("Chapter23")}`);
console.log(`  App has ch32: ${ungz(vm[APP_UUID].data).includes("Chapter32")}`);
console.log(`  No ch1: ${!ungz(vm[APP_UUID].data).includes("Chapter1")}`);
console.log(`  Title: ${vt.match(/<title>([^<]+)<\/title>/)?.[1]}`);
console.log(`  SVG: ${vt.includes(newSvgText) ? '✅ updated' : '❌ not updated'}`);

let o = 0;
for (let ch = 23; ch <= 32; ch++) {
  if (vs.some(u => vm[u]?.compressed && ungz(vm[u].data).includes(`Chapter${ch}(`))) o++;
}
console.log(`  Chapters found in manifest+template: ${o}/10`);
console.log(`  File: ${(Buffer.byteLength(v)/1024/1024).toFixed(1)}MB`);
