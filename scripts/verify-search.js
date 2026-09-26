/**
 * 搜索页真实产体验证。
 *
 * 用 src/content/bundle.exposed.js（与正式产物内容相同，仅多暴露内部函数）
 * 注入真实搜索页，按页面类型分流后调用真实的收集逻辑。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function evalInBrowser(code) {
  const res = spawnSync('agent-browser', ['eval', '--stdin'], {
    input: code,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 100000,
    shell: true,
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`无输出。stderr: ${(res.stderr || '').slice(0, 300)}`);
  let parsed = JSON.parse(out);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

function buildInjected() {
  const bundle = readFileSync(join(ROOT, 'src/content/bundle.exposed.js'), 'utf8');
  return `(() => {
  const chromeStub = {
    runtime: {
      id: 'probe', getURL: (p) => 'chrome-extension://probe/' + p, lastError: undefined,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  const runBundle = (chrome) => {
${bundle}
  };
  try { runBundle(chromeStub); } catch (e) {
    return JSON.stringify({ ok: false, phase: 'bundle', error: e.message });
  }
  const G = window.__GHST__;
  if (!G) return JSON.stringify({ ok: false, phase: 'expose', error: '无 __GHST__' });
  try {
    const pageType = G.detectPageType(location.href);
    const strategy = G.getContentStrategy ? G.getContentStrategy(pageType) : null;
    const report = G.findContentContainers({
      fallbackAllowed: strategy ? strategy.allowFallback : true,
      useSearchSelectors: strategy ? strategy.useSearchSelectors : false,
    });
    const units = G.collectTextNodes({ report });
    return JSON.stringify({
      ok: true,
      url: location.href,
      pageType,
      strategy,
      usedSearchSelectors: report.usedSearchSelectors,
      // 调试：确认搜索专用排除规则确实被带进收集阶段
      hasSearchExcludes: /TopicLabel/.test(String(report.excludeSelector || '')),
      excludeLen: String(report.excludeSelector || '').length,
      containerCount: report.elements.length,
      matched: report.matchedSelectors.map((m) => m.selector + 'x' + m.count),
      unitCount: units.length,
      aggregated: units.filter((u) => u.nodes.length > 1).length,
      samples: units.slice(0, 10).map((u) => u.text.slice(0, 80)),
    });
  } catch (e) {
    return JSON.stringify({ ok: false, phase: 'collect', error: e.message });
  }
})()`;
}

const urls = process.argv.slice(2);
for (const url of urls) {
  console.log(`\n${'='.repeat(70)}\n搜索页验证: ${url}\n${'='.repeat(70)}`);
  try {
    execFileSync('agent-browser', ['open', url], {
      encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 80000,
    });
  } catch (e) {
    console.log(`导航警告（继续注入）: ${String(e.message).split('\n')[0]}`);
  }
  try {
    execFileSync('agent-browser', ['wait', '3500'], {
      encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 20000,
    });
  } catch { /* 忽略 */ }

  try {
    const r = evalInBrowser(buildInjected());
    if (!r.ok) {
      console.log(`\x1b[31m✗ ${r.phase} 阶段失败: ${r.error}\x1b[0m`);
      continue;
    }
    console.log(`页面类型: ${r.pageType}`);
    console.log(`策略: ${JSON.stringify(r.strategy)}`);
    console.log(`用搜索选择器: ${r.usedSearchSelectors}`);
    console.log(
      `排除规则含 TopicLabel: ${r.hasSearchExcludes}  (规则串长度 ${r.excludeLen})`
    );
    console.log(`容器 ${r.containerCount} 个   命中: ${r.matched.join(', ')}`);
    console.log(
      `翻译单元 \x1b[1m${r.unitCount}\x1b[0m 个（聚合 ${r.aggregated} 个）`
    );
    console.log('样本:');
    for (const s of r.samples) console.log(`  · ${s}`);
  } catch (e) {
    console.log(`注入失败: ${e.message}`);
  }
}
