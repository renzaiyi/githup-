/**
 * 真实产体验证：把 src/content/bundle.js 注入真实 GitHub 页面，
 * 调用其中真实的 collectTextNodes() / findContentContainers()，报告覆盖情况。
 *
 * 【为什么这个脚本比 run-probe.js 可信】
 * run-probe.js 里有一份手写的收集逻辑副本，一旦源码改动就会与真实行为脱节。
 * 这个脚本用的是**打包产物本身** —— 也就是真正会被 Edge 加载的那段代码，
 * 所以它验证的是"真东西"。
 *
 * 用法：node scripts/verify-bundle.js <url> [url2 ...]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 把真实产物 + 一个探针尾巴拼成一段可注入的脚本 */
function buildInjected() {
  // 用 bundle.exposed.js：它与正式产物内容完全相同，
  // 只是额外把内部函数挂到 window.__GHST__ 上，以便外部调用验证。
  const bundle = readFileSync(join(ROOT, 'src/content/bundle.exposed.js'), 'utf8');

  return `(() => {
  // ---- chrome API 桩件（页面主世界没有扩展上下文）----
  // 用函数参数注入而不是 window.chrome = {...}：
  // Chrome 里 chrome 是只读属性，赋值会被静默忽略。
  const chromeStub = {
    runtime: {
      id: 'probe-stub',
      getURL: (p) => 'chrome-extension://probe/' + p,
      lastError: undefined,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };

  // ---- 以下为真实产物（原样，只包进带 chrome 形参的函数）----
  const runBundle = (chrome) => {
${bundle}
  };

  try {
    runBundle(chromeStub);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      phase: 'bundle',
      error: e.message,
      at: (e.stack || '').split('\\n')[1],
    });
  }

  // ---- 探针：调用真实函数 ----
  const G = window.__GHST__;
  if (!G) {
    return JSON.stringify({
      ok: false,
      phase: 'expose',
      error: 'window.__GHST__ 不存在 —— 暴露层没有生效',
    });
  }

  try {
    const report = G.findContentContainers({ fallbackAllowed: true });
    const units = G.collectTextNodes({ report });
    const multi = units.filter((u) => u.nodes.length > 1);

    return JSON.stringify({
      ok: true,
      url: location.href,
      containerCount: report.elements.length,
      usedFallback: report.usedFallback,
      unitCount: units.length,
      aggregatedUnits: multi.length,
      textNodeTotal: units.reduce((n, u) => n + u.nodes.length, 0),
      matchedSelectors: report.matchedSelectors,
      samples: units.slice(0, 8).map((u) => ({
        text: u.text.slice(0, 90),
        nodes: u.nodes.length,
      })),
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      phase: 'collect',
      error: e.message,
      at: (e.stack || '').split('\\n')[1],
    });
  }
})()`;
}

/**
 * 把代码通过 stdin 管道传给 agent-browser。
 *
 * 【踩过的两个坑】
 * 1. 用 base64 当命令行参数：bundle 约 60 KB，base64 后 80 KB，
 *    超出 Windows 命令长度限制，表现为 spawnSync 超时。
 * 2. 用 cmd /c type 做重定向：Node 会对参数做转义，路径里的引号被破坏，
 *    报 "filename or volume label syntax is incorrect"。
 *
 * 正确做法：spawnSync 直接写 stdin —— 不经 shell，没有长度与转义问题。
 */
function evalInBrowser(code) {
  const res = spawnSync('agent-browser', ['eval', '--stdin'], {
    input: code,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
    shell: true,
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (!out) {
    throw new Error(`agent-browser 无输出。stderr: ${(res.stderr || '').slice(0, 300)}`);
  }
  let parsed = JSON.parse(out);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('用法: node scripts/verify-bundle.js <url> [url2 ...]');
  process.exit(1);
}

const results = [];
for (const url of urls) {
  console.log(`\n${'='.repeat(72)}\n真实产体验证: ${url}\n${'='.repeat(72)}`);
  try {
    execFileSync('agent-browser', ['open', url], {
      encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 90000,
    });
    try {
      execFileSync('agent-browser', ['wait', '--load', 'networkidle'], {
        encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 45000,
      });
    } catch {
      execFileSync('agent-browser', ['wait', '2500'], { encoding: 'utf8', shell: true, stdio: 'pipe' });
    }

    const r = evalInBrowser(buildInjected());
    results.push(r);
    if (!r.ok) {
      console.log(`\x1b[31m✗ 执行真实产物出错：${r.error}\x1b[0m`);
      continue;
    }

    console.log(`容器 ${r.containerCount} 个   降级=${r.usedFallback}`);
    console.log(
      `翻译单元 \x1b[1m${r.unitCount}\x1b[0m 个` +
        `（其中聚合单元 ${r.aggregatedUnits} 个，覆盖文本节点 ${r.textNodeTotal} 个）`
    );
    console.log('命中的选择器:');
    for (const m of r.matchedSelectors.slice(0, 6)) {
      console.log(`  · ${m.selector} × ${m.count}`);
    }
    console.log('样本（聚合后的完整句子）:');
    for (const s of r.samples) {
      console.log(`  · [${s.nodes}节点] ${s.text}`);
    }
  } catch (e) {
    console.log(`失败: ${e.message}`);
    results.push({ url, ok: false, error: e.message });
  }
}

console.log(`\n${'='.repeat(72)}`);
const ok = results.filter((r) => r.ok);
if (ok.length) {
  const total = ok.reduce((n, r) => n + r.unitCount, 0);
  const agg = ok.reduce((n, r) => n + r.aggregatedUnits, 0);
  console.log(`汇总：${ok.length} 个页面可用，共 ${total} 个翻译单元（聚合 ${agg} 个）`);
}
