/**
 * 构建脚本：把内容脚本的模块图打包成【单个经典脚本】。
 *
 * 【为什么需要它】
 * manifest 里的 "type": "module" 会让内容脚本异步加载，带来两个真实问题：
 *   1. 消息监听器可能来不及注册 —— 真机上表现为"点翻译没反应、说没有运行扩展"
 *   2. 任何一个 import 失败，整个模块一行都不执行，且症状很隐蔽
 *
 * 打包成经典脚本后：
 *   - 同步执行，监听器立即就位
 *   - 零 import，不存在模块解析失败
 *   - 只有 1 个文件，Chrome/Edge 的加载路径最短
 *
 * 做法：按依赖顺序拼接，剥掉 import/export 语句（它们在同一作用域里本就不需要），
 * 并用 Set 去重标识符，防止模块间重名导致重复声明。
 *
 * 用法：node scripts/build-content.js
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 拼接顺序 = 依赖顺序（被依赖的在前）。
 * 这个顺序是手工确定的，改动模块时如果新增了跨模块依赖，需要相应调整。
 */
const MODULES = [
  'src/shared/constants.js',
  'src/shared/util.js',
  'src/shared/settings.js',
  'src/shared/cache.js',
  'src/shared/prompts.js',
  'src/shared/github-context.js',
  'src/core/parse.js',
  'src/core/translate.js',
  'src/core/dom.js',
  'src/core/styles.js',
  'src/content/main.js',
];

/** 剥掉 import 语句与 export 关键字 */
function strip(code, fileLabel) {
  let out = code;

  // 1) 多行 import { ... } from '...'
  out = out.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  // 2) 单行裸 import '...'
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  // 3) 再扫一遍，捕捉上面正则漏掉的多行形式
  out = out.replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '');

  // 4) export { a, b } / export { a as b }
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  // 5) export const/let/var/function/class → 去掉 export 前缀
  out = out.replace(/^(\s*)export\s+(async\s+)?(function|class|const|let|var)\b/gm, '$1$2$3');

  // 6) export default → 不支持，明确报错而不是静默产出坏代码
  if (/export\s+default/.test(out)) {
    throw new Error(`${fileLabel} 含有 export default，打包脚本不支持`);
  }

  // 7) 残留的 import 必须报错，否则会产出语法错误的产物
  const leftover = out.match(/^\s*import\s/m);
  if (leftover) {
    const line = out.split('\n').find((l) => /^\s*import\s/.test(l));
    throw new Error(`${fileLabel} 仍有未处理的 import：${line?.trim()}`);
  }

  return out;
}

/** 取出模块里的顶层声明名，用于去重 */
function topLevelNames(code) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) names.add(m[1]);
  }
  return names;
}

/* ------------------------------------------------------------------ */

const seen = new Set();
const chunks = [];
const report = [];

for (const rel of MODULES) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.error(`\x1b[31m缺少模块：${rel}\x1b[0m`);
    process.exit(1);
  }
  const original = readFileSync(file, 'utf8');
  const code = strip(original, rel);

  // 去掉这个模块的文件头注释块之外的多余空行，保持产物可读
  const body = code.replace(/\n{3,}/g, '\n\n').trim();
  if (!body) continue;

  // 检测重复声明（不同模块导出同名标识符 → 打包后会重复声明报错）
  const names = topLevelNames(body);
  const dupes = [...names].filter((n) => seen.has(n));
  if (dupes.length) {
    console.error(
      `\x1b[33m! ${rel} 与前面的模块重名：${dupes.join(', ')}` +
        `\n  打包后会变成重复声明。请给其中一个改名。\x1b[0m`
    );
  }
  for (const n of names) seen.add(n);

  report.push({ rel, bytes: body.length, decls: names.size });
  chunks.push(
    `/* ============================================================\n` +
      ` * 来自 ${rel}\n` +
      ` * ============================================================ */\n${body}`
  );
}

const banner = `/**
 * GitHub 智能翻译 · 内容脚本（自动生成，请勿直接编辑）
 *
 * 由 scripts/build-content.js 从以下模块打包而成：
${report.map((r) => ` *   - ${r.rel}  (${r.decls} 个顶层声明, ${r.bytes} 字节)`).join('\n')}
 *
 * 【为什么要打包成单文件】
 * manifest 用 "type": "module" 时内容脚本是异步加载的，会导致消息监听器
 * 注册晚于 popup 发消息（真机实测症状：「没有运行扩展」）。打包成经典脚本后
 * 同步执行、零 import，把这类失败模式整个消除。
 *
 * 修改源码后请重新运行：node scripts/build-content.js
 */
(function () {
  'use strict';

`;

const footer = `
})();
`;

/**
 * 供真机验证用的暴露尾巴。
 *
 * 【为什么需要它】
 * 内容脚本被包在 IIFE 里，内部函数（collectTextNodes 等）在外部拿不到，
 * 所以无法在真实页面上调用它们做验证。加上 --expose 后额外生成一份
 * bundle.exposed.js，把内部函数挂到 window.__GHST__ 上。
 *
 * 它**只用于验证**，不进 manifest，不会被 Edge 加载。
 */
const exposeFooter = `
  // ---- 验证专用暴露层（仅 bundle.exposed.js 含有）----
  try {
    window.__GHST__ = {
      collectTextNodes,
      findContentContainers,
      getLastReport,
      injectTranslation,
      applyMode,
      removeAllTranslations,
      countInjected,
      detectPageType,
      isFallbackAllowedForPage,
      getContentStrategy,
      buildPageContext,
      buildContextKey,
      state,
    };
  } catch (e) {
    console.error('[ghst] 暴露内部函数失败：', e);
  }
})();
`;

const expose = process.argv.includes('--expose');

const out = banner + chunks.join('\n\n') + footer;
const outFile = join(ROOT, 'src/content/bundle.js');
writeFileSync(outFile, out, 'utf8');

console.log('\n=== 打包完成 ===');
for (const r of report) {
  console.log(`  ${r.rel.padEnd(34)} ${String(r.decls).padStart(3)} 个声明  ${String(r.bytes).padStart(6)} 字节`);
}
console.log(`\n  产物: src/content/bundle.js  (${out.length} 字节)`);
console.log(`  顶层标识符去重: ${seen.size} 个`);

if (expose) {
  const exposedOut = banner + chunks.join('\n\n') + exposeFooter;
  const exposedFile = join(ROOT, 'src/content/bundle.exposed.js');
  writeFileSync(exposedFile, exposedOut, 'utf8');
  console.log(
    `  验证产物: src/content/bundle.exposed.js  (${exposedOut.length} 字节)` +
      `\n     含 window.__GHST__ 暴露层，仅供真机验证，不进 manifest。`
  );
}

console.log('\n注意：bundle.js 是生成物，修改源码后必须重新运行本脚本。');
