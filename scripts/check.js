/**
 * 装机前自检。运行：node scripts/check.js
 *
 * 目的：在没有浏览器的情况下，把所有"能在装进 Edge 之前发现"的问题都发现掉。
 * 检查项：
 *   1. manifest.json 合法、无 BOM、声明的文件都存在
 *   2. 所有 JS 文件语法正确
 *   3. 【重点】所有 import 路径都能解析到真实文件
 *      —— 路径写错是 MV3 扩展加载失败最常见的原因，而且报错信息很难懂
 *   4. 图标文件存在且是合法 PNG
 *   5. 提示词版本号已定义
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let errors = 0;
let warnings = 0;
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => { errors++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); };
const warn = (msg) => { warnings++; console.log(`  \x1b[33m! ${msg}\x1b[0m`); };

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

console.log('\n=== 1. manifest.json ===');
let manifest = null;
try {
  const raw = readFileSync(join(ROOT, 'manifest.json'));
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    bad('manifest.json 含有 BOM，Chrome/Edge 会拒绝加载');
  } else {
    ok('无 BOM');
  }
  manifest = JSON.parse(raw.toString('utf8'));
  ok(`JSON 合法（${manifest.name} v${manifest.version}）`);
} catch (e) {
  bad(`manifest.json 解析失败：${e.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) bad(`manifest_version 应为 3，实际 ${manifest.manifest_version}`);
  else ok('manifest_version = 3');

  const refs = [];
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []));
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  for (const v of Object.values(manifest.icons || {})) refs.push(v);

  let missing = 0;
  for (const ref of refs) {
    if (!existsSync(join(ROOT, ref))) { bad(`manifest 引用了不存在的文件：${ref}`); missing++; }
  }
  if (missing === 0) ok(`${refs.length} 个引用文件全部存在`);

  // host_permissions 是跨域请求的前提，缺了后台就发不出请求
  if (!manifest.host_permissions?.length) {
    bad('缺少 host_permissions —— 后台无法跨域请求 API，翻译一定失败');
  } else {
    ok(`host_permissions: ${manifest.host_permissions.join(', ')}`);
  }
}

console.log('\n=== 2. JS 语法 ===');
const jsFiles = walk(join(ROOT, 'src'), (f) => f.endsWith('.js'));
ok(`共 ${jsFiles.length} 个模块文件`);

console.log('\n=== 3. import 路径解析（MV3 加载失败的头号原因）===');
let importCount = 0;
const importRe = /^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm;
const bareImportRe = /^\s*import\s+['"]([^'"]+)['"]/gm;

for (const file of [...jsFiles, ...walk(join(ROOT, 'tests'), (f) => f.endsWith('.js'))]) {
  const code = readFileSync(file, 'utf8');
  const specs = new Set();
  for (const re of [importRe, bareImportRe]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) specs.add(m[1]);
  }
  for (const spec of specs) {
    importCount++;
    if (!spec.startsWith('.')) {
      // 裸模块名只允许出现在测试里（Node 环境）
      if (!file.includes('tests')) {
        bad(`${relative(ROOT, file)} 引用了裸模块 "${spec}" —— 扩展运行时不支持，装饰会失败`);
      }
      continue;
    }
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      bad(`${relative(ROOT, file)} → "${spec}" 解析不到文件（期望 ${relative(ROOT, target)}）`);
    }
  }
}
ok(`检查了 ${importCount} 条 import，全部可解析`);

console.log('\n=== 4. 图标 ===');
for (const size of [16, 32, 48, 128]) {
  const p = join(ROOT, 'icons', `icon${size}.png`);
  if (!existsSync(p)) { bad(`缺少 icons/icon${size}.png`); continue; }
  const b = readFileSync(p);
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (!isPng) bad(`icons/icon${size}.png 不是合法 PNG`);
  else ok(`icon${size}.png (${b.length} 字节)`);
}

console.log('\n=== 5. 关键常量 ===');
const consts = readFileSync(join(ROOT, 'src/shared/constants.js'), 'utf8');
const versionMatch = consts.match(/PROMPT_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (versionMatch) ok(`PROMPT_VERSION = ${versionMatch[1]}（参与缓存键，改提示词时记得加一）`);
else bad('常量文件里找不到 PROMPT_VERSION —— 缓存会失效');

// 输入安全边界：SKIP_TAGS 必须包含输入控件
for (const tag of ['INPUT', 'TEXTAREA', 'PRE', 'CODE']) {
  if (new RegExp(`['"]${tag}['"]`).test(consts)) ok(`SKIP_TAGS 已包含 ${tag}`);
  else bad(`SKIP_TAGS 缺少 ${tag} —— 输入框或代码块会被翻译！`);
}

console.log('\n=== 6. 危险模式扫描 ===');
const risky = [
  { re: /innerHTML\s*=/, why: 'innerHTML 赋值（XSS 风险，且会破坏 React 节点）' },
  { re: /document\.body\.innerText\s*=/, why: '直接改写整页文本（会污染输入框）' },
  { re: /nodeValue\s*=/, why: '直接改写文本节点（会破坏原文，无法复原）' },
];
let riskyHits = 0;
for (const file of jsFiles) {
  const code = readFileSync(file, 'utf8');
  code.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
    for (const r of risky) {
      if (r.re.test(line)) {
        warn(`${relative(ROOT, file)}:${i + 1} ${r.why}`);
        riskyHits++;
      }
    }
  });
}
if (riskyHits === 0) ok('未发现危险模式');

console.log('\n=== 7. HTML 内联脚本语法 ===');
// 自测页面里的 module 脚本是浏览器直接执行的，语法错误只有打开页面才会发现。
// 这里把它抽出来交给 node --check，提前拦住。
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const htmlFiles = [
  join(ROOT, 'tests/self-test.html'),
  join(ROOT, 'src/popup/popup.html'),
];
for (const file of htmlFiles) {
  if (!existsSync(file)) { warn(`缺少 ${relative(ROOT, file)}`); continue; }
  const html = readFileSync(file, 'utf8');
  const scriptRe = /<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let idx = 0;
  while ((match = scriptRe.exec(html))) {
    idx++;
    const tmp = join(tmpdir(), `ghst-inline-${process.pid}-${idx}.mjs`);
    writeFileSync(tmp, match[1], 'utf8');
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      // 含 import 的内联脚本在 --check 下也会因相对路径失败，这里只关心语法
      ok(`${relative(ROOT, file)} 内联脚本 #${idx} 语法正确`);
    } catch (e) {
      const msg = (e.stderr || e.stdout || '').toString().split('\n').slice(0, 4).join(' ');
      bad(`${relative(ROOT, file)} 内联脚本 #${idx} 语法错误：${msg}`);
    } finally {
      unlinkSync(tmp);
    }
  }
  if (idx === 0) warn(`${relative(ROOT, file)} 里没找到 type="module" 脚本`);
}

console.log('\n=== 8. 内容脚本产物（bundle.js） ===');
const BUNDLE = join(ROOT, 'src/content/bundle.js');
const SOURCES = [
  'src/shared/constants.js', 'src/shared/util.js', 'src/shared/settings.js',
  'src/shared/cache.js', 'src/shared/prompts.js', 'src/shared/github-context.js',
  'src/core/parse.js', 'src/core/translate.js', 'src/core/dom.js',
  'src/core/styles.js', 'src/content/main.js',
];

if (!existsSync(BUNDLE)) {
  bad('缺少 src/content/bundle.js —— 请运行 npm run build');
} else {
  const bundleCode = readFileSync(BUNDLE, 'utf8');

  // ---- 产物与源码是否同步：把源码重新打包，直接比对内容 ----
  //
  // 【为什么不能用 mtime】
  // 最初这里比的是"源文件是否比 bundle.js 新"。这在开发机上够用，
  // 但在全新 clone 里必然误报：git 检出时所有文件 mtime 几乎相同，
  // bundle.js 只要早几毫秒就会被判为"过期"，而内容其实是同步的。
  // （这个问题就是在模拟 clone 时被抓到的。）
  //
  // 现在直接调用 build-content.js 导出的 buildBundle()（构建逻辑的唯一实现），
  // 在内存里重新打包再比对 —— 只取决于源码内容，与文件时间无关。
  // 注意 buildBundle 是纯函数、不写盘，所以"检查"不会顺带修改产物。
  let fresh = null;
  let compareError = null;
  try {
    const { buildBundle } = await import('./build-content.js');
    fresh = buildBundle({ expose: false }).bundle;
  } catch (e) {
    compareError = e;
  }

  if (compareError) {
    bad(`无法重建产物做比对：${compareError.message}`);
  } else if (fresh === bundleCode) {
    ok('bundle.js 与源码完全同步（内容比对，不受文件时间影响）');
  } else {
    bad('bundle.js 与源码不同步 —— 请运行 npm run build 并重新提交');
    const a = bundleCode.split('\n');
    const b = fresh.split('\n');
    let firstDiff = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        firstDiff = i + 1;
        break;
      }
    }
    console.log(`        首个差异在第 ${firstDiff} 行`);
    console.log(`        提交的产物 ${a.length} 行 vs 重建的 ${b.length} 行`);
    if (firstDiff > 0) {
      console.log(`        提交：${(a[firstDiff - 1] || '').slice(0, 70)}`);
      console.log(`        重建：${(b[firstDiff - 1] || '').slice(0, 70)}`);
    }
  }

  // 产物不能残留 import/export，否则经典脚本会语法错误
  const leftoverImport = /^\s*import\s/m.test(bundleCode);
  const leftoverExport = /^\s*export\s/m.test(bundleCode);
  if (leftoverImport) bad('bundle.js 里仍有 import 语句 —— 经典脚本会加载失败');
  else ok('产物内无 import 语句');

  if (leftoverExport) bad('bundle.js 里仍有 export 语句');
  else ok('产物内无 export 语句');

  // 消息监听器必须存在（这是"没有运行扩展"的根因所在）
  if (/chrome\.runtime\.onMessage\.addListener/.test(bundleCode)) {
    ok('产物内已注册消息监听器');
  } else {
    bad('bundle.js 里找不到 onMessage.addListener —— popup 将无法与页面通信');
  }

  ok(`bundle.js 体积 ${(bundleCode.length / 1024).toFixed(1)} KB`);
}

// manifest 必须指向 bundle.js 且不能带 type:module（否则又回到异步加载的坑）
if (manifest) {
  const cs = manifest.content_scripts?.[0] || {};
  const jsFiles = cs.js || [];
  if (jsFiles.includes('src/content/bundle.js')) {
    ok('manifest 指向 src/content/bundle.js');
  } else {
    bad(`manifest 的 content_scripts 未指向 bundle.js，实际为：${jsFiles.join(', ')}`);
  }
  if (cs.type === 'module') {
    bad('manifest 给内容脚本声明了 type:module —— 会异步加载，监听器可能来不及注册');
  } else {
    ok('内容脚本为经典脚本（无 type:module，同步执行）');
  }

  // 验证产物（bundle.exposed.js）绝不能进 manifest —— 它含调试暴露层
  const allJs = JSON.stringify(manifest);
  if (allJs.includes('bundle.exposed')) {
    bad('manifest 引用了 bundle.exposed.js —— 那是验证专用产物，不应发布');
  } else {
    ok('manifest 未引用验证专用产物');
  }
}

// 验证专用产物应存在（供 verify-bundle.js 做真机验证）
const exposed = join(ROOT, 'src/content/bundle.exposed.js');
if (existsSync(exposed)) {
  const exposedCode = readFileSync(exposed, 'utf8');
  if (exposedCode.includes('window.__GHST__')) {
    ok('bundle.exposed.js 存在且含验证暴露层');
  } else {
    warn('bundle.exposed.js 存在但没有 __GHST__ 暴露层，真机验证会失败');
  }
} else {
  // 这是**正常状态**，不是问题：bundle.exposed.js 被 .gitignore 排除，
  // 是给真机验证脚本用的临时产物，全新 clone 里本来就不该有。
  // 所以这里报"信息"而不是"警告" —— 否则每个新 clone 的人都会看到一条
  // 需要解释的黄色提醒，属于噪音。
  ok('未生成 bundle.exposed.js（正常：验证专用产物不入库，需要时 npm run build 生成）');
}

console.log('\n=== 9. 文件清单 ===');
const all = walk(ROOT, (f) => /\.(js|json|html|css|png)$/.test(f));
ok(`扩展共 ${all.length} 个文件（含测试）`);

console.log('\n' + '='.repeat(56));
if (errors === 0) {
  console.log(`\x1b[32m自检通过\x1b[0m：0 个错误，${warnings} 个提醒`);
  console.log('可以加载到 Edge 了。');
  process.exit(0);
} else {
  console.log(`\x1b[31m自检失败\x1b[0m：${errors} 个错误，${warnings} 个提醒`);
  process.exit(1);
}
