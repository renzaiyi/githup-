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

// 注意：模块迭代逻辑已全部收进 buildBundle()（本文件下方导出），
// 这里不再重复一份 —— check.js 也调用同一个函数做"产物是否同步"的比对，
// 保证只有一份构建实现。

/**
 * 构建产物内容（纯函数，不写盘）。
 *
 * 【为什么导出这个】
 * scripts/check.js 需要"把源码重新打包一遍、与已提交的产物比对内容"，
 * 以此判断产物是否与源码同步。
 * 如果 check.js 自己再实现一份打包逻辑，就出现了第二份真相源 ——
 * 两份实现迟早不一致，那种"检查通过但产物其实是错的"最危险。
 * 所以这里导出唯一的构建实现，谁要构建都调它。
 *
 * @param {{ expose?: boolean }} [options]
 * @returns {{ bundle: string, exposed: string|null, report: Array }}
 */
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

export function buildBundle(options = {}) {
  const seen = new Set();
  const chunks = [];
  const report = [];

  for (const rel of MODULES) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) {
      throw new Error(`缺少模块：${rel}`);
    }
    const original = readFileSync(file, 'utf8');
    const code = strip(original, rel);

    // 去掉多余空行，保持产物可读
    const body = code.replace(/\n{3,}/g, '\n\n').trim();
    if (!body) continue;

    // 检测重复声明（不同模块导出同名标识符 → 打包后会重复声明报错）
    const names = topLevelNames(body);
    const dupes = [...names].filter((n) => seen.has(n));
    if (dupes.length) {
      throw new Error(
        `${rel} 与前面的模块重名：${dupes.join(', ')} —— 打包后会变成重复声明，请改名`
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
 * 修改源码后请重新运行：npm run build
 */
(function () {
  'use strict';

`;

  const footer = `
})();
`;

  const bundle = banner + chunks.join('\n\n') + footer;
  const exposed = options.expose ? banner + chunks.join('\n\n') + exposeFooter : null;

  return { bundle, exposed, report, declCount: seen.size };
}


/**
 * 只有被直接执行时才写盘。
 *
 * check.js 会 import 本文件来复用 buildBundle()，
 * 那时绝不能让下面这段副作用代码跑起来（否则"检查"会顺带改写产物，
 * 检查就永远通过了 —— 这正是要避免的自欺欺人）。
 */
const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const expose = process.argv.includes('--expose');
  const { bundle, exposed, report, declCount } = buildBundle({ expose });

  writeFileSync(join(ROOT, 'src/content/bundle.js'), bundle, 'utf8');

  console.log('\n=== 打包完成 ===');
  for (const r of report) {
    console.log(
      `  ${r.rel.padEnd(34)} ${String(r.decls).padStart(3)} 个声明  ${String(r.bytes).padStart(6)} 字节`
    );
  }
  console.log(`\n  产物: src/content/bundle.js  (${bundle.length} 字节)`);
  console.log(`  顶层标识符去重: ${declCount} 个`);

  if (exposed) {
    writeFileSync(join(ROOT, 'src/content/bundle.exposed.js'), exposed, 'utf8');
    console.log(
      `  验证产物: src/content/bundle.exposed.js  (${exposed.length} 字节)` +
        `\n     含 window.__GHST__ 暴露层，仅供真机验证，不进 manifest。`
    );
  }

  console.log('\n注意：bundle.js 是生成物，修改源码后必须重新运行 npm run build。');
}
