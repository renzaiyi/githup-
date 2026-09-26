/**
 * 校验所有具名 import 在目标模块里确实被导出。
 *
 * 为什么需要这个：ESM 的具名导入如果名字不存在，**模块求值会直接抛错**，
 * 结果是整个内容脚本一行都不执行 —— 表现就是"扩展装了、按钮有、但页面没反应"。
 * 常规语法检查（node --check）抓不到这个，因为它只管语法不管绑定。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 提取一个模块导出的所有名字 */
function getExports(file) {
  const code = readFileSync(file, 'utf8');
  const names = new Set();

  // export function foo / export async function foo / export class Foo
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export const foo = / export let foo = / export var foo =
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : t.replace(/^type\s+/, '').split(/\s+/)[0]);
    }
  }
  // export * from '...' → 递归并入
  for (const m of code.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolve(dirname(file), m[1]);
    if (existsSync(target)) for (const n of getExports(target)) names.add(n);
  }
  // export default
  if (/export\s+default\b/.test(code)) names.add('default');

  return names;
}

/** 提取一个模块的所有具名导入：返回 [{name, source}] */
function getImports(file) {
  const code = readFileSync(file, 'utf8');
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim();
    const source = m[2];
    // 默认导入： import Foo from '...'
    const defMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defMatch && !clause.startsWith('{') && !clause.startsWith('*')) {
      out.push({ name: 'default', source, as: defMatch[1] });
    }
    // 具名导入： { a, b as c }
    const braceMatch = clause.match(/\{([\s\S]*?)\}/);
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch) out.push({ name: asMatch[1], source, as: asMatch[2] });
        else out.push({ name: t.split(/\s+/)[0], source, as: t.split(/\s+/)[0] });
      }
    }
    // 命名空间导入： * as ns
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) out.push({ name: '*', source, as: nsMatch[1] });
  }
  return out;
}

/* ------------------------------------------------------------------ */

let errors = 0;
const files = walk(join(ROOT, 'src'));

console.log('\n=== 具名导出/导入绑定校验 ===');
for (const file of files) {
  const imports = getImports(file);
  for (const imp of imports) {
    if (!imp.source.startsWith('.')) continue; // 裸模块跳过
    const target = resolve(dirname(file), imp.source);
    if (!existsSync(target)) {
      console.log(`  \x1b[31m✗ ${relative(ROOT, file)} → "${imp.source}" 文件不存在\x1b[0m`);
      errors++;
      continue;
    }
    if (imp.name === '*') continue;
    const exports = getExports(target);
    if (!exports.has(imp.name)) {
      console.log(
        `  \x1b[31m✗ ${relative(ROOT, file)}\n     导入了 { ${imp.name} } 但 ${relative(ROOT, target)} 并未导出它` +
          `\n     （该模块实际导出：${[...exports].slice(0, 12).join(', ') || '（无）'}）\x1b[0m`
      );
      errors++;
    }
  }
}

if (errors === 0) {
  console.log(`  \x1b[32m✓ 检查了 ${files.length} 个模块，所有具名导入都能解析到真实导出\x1b[0m`);
} else {
  console.log(`\n  \x1b[31m发现 ${errors} 处绑定错误 —— 这会导致内容脚本整个模块不执行\x1b[0m`);
  console.log('  表现：扩展已安装、popup 正常，但页面里内容脚本无响应。');
}

/* ------------------------------------------------------------------ */
/* 额外：被 popup / content / background 实际引用到的常量是否都存在    */
/* ------------------------------------------------------------------ */
console.log('\n=== 关键常量存在性 ===');
const consts = readFileSync(join(ROOT, 'src/shared/constants.js'), 'utf8');
for (const name of [
  'CONTENT_SELECTORS', 'EXCLUDE_SELECTORS', 'EXCLUDE_UI_SELECTORS',
  'FALLBACK_CONTAINER_SELECTORS', 'SKIP_TAGS', 'MODES', 'BATCH_SIZE',
  'MAX_CONCURRENCY', 'PROMPT_VERSION', 'MIN_TEXT_LENGTH', 'MAX_TEXT_LENGTH', 'NS',
  'STORAGE_KEYS', 'DEFAULT_SETTINGS',
]) {
  if (new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`).test(consts)) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    console.log(`  \x1b[31m✗ 常量 ${name} 未导出\x1b[0m`);
    errors++;
  }
}

console.log('\n' + '='.repeat(56));
if (errors === 0) {
  console.log('\x1b[32m绑定校验通过\x1b[0m：不存在"导入了不存在的名字"这类问题');
  process.exit(0);
} else {
  console.log(`\x1b[31m绑定校验失败\x1b[0m：${errors} 处问题`);
  process.exit(1);
}
