/**
 * 搜索结果页结构探针（精简版）。
 * 只输出"该加什么选择器"所需的最小信息，避免脚本过长导致注入超时。
 */
import { spawnSync, execFileSync } from 'node:child_process';

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

const PROBE = `(() => {
  const r = { url: location.href, title: document.title.slice(0, 60) };

  const list = document.querySelector('[data-testid="results-list"]');
  r.hasList = !!list;
  r.itemCount = list ? list.children.length : 0;

  const CONTENT = ['.markdown-body','[data-testid="results-list"]','.search-title',
    '[class*="SearchResult"]','[class*="search-title"]','.repo-list','.codesearch-results'];
  r.hits = CONTENT.map((s) => {
    let n = 0; try { n = document.querySelectorAll(s).length; } catch (e) {}
    return s + '=' + n;
  });

  r.samples = [];
  if (list) {
    const items = Array.from(list.children).slice(0, 2);
    for (let i = 0; i < items.length; i++) {
      const els = items[i].querySelectorAll('h3, p, span, a');
      const texts = [];
      for (const el of els) {
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.nodeValue.trim())
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim();
        if (own.length >= 3 && /[A-Za-z]{2,}/.test(own)) {
          texts.push(el.tagName + '|' + own.slice(0, 55));
        }
        if (texts.length >= 6) break;
      }
      r.samples.push(texts);
    }
  }

  if (list) {
    r.listAttrs = {
      tag: list.tagName,
      cls: String(list.className || '').slice(0, 70),
      testid: list.getAttribute('data-testid'),
      parentTag: list.parentElement ? list.parentElement.tagName : '',
      parentCls: list.parentElement ? String(list.parentElement.className || '').slice(0, 70) : '',
    };
  }
  return JSON.stringify(r);
})()`;

const url = process.argv[2];
if (!url) { console.error('用法: node scripts/probe-search.js <url>'); process.exit(1); }

try {
  execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 80000 });
} catch (e) {
  console.log(`导航超时/失败（继续尝试注入）: ${String(e.message).split('\n')[0]}`);
}
try {
  execFileSync('agent-browser', ['wait', '3000'], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 20000 });
} catch { /* 忽略 */ }

console.log(`\n=== 搜索页结构 ===`);
try {
  const r = evalInBrowser(PROBE);
  console.log(`标题: ${r.title}`);
  console.log(`\n[data-testid="results-list"] 存在: ${r.hasList}   结果项: ${r.itemCount}`);
  console.log(`\n现有选择器命中: ${r.hits.join('  ')}`);
  if (r.listAttrs) {
    console.log(`\nlist 元素: <${r.listAttrs.tag}> class="${r.listAttrs.cls}" testid="${r.listAttrs.testid}"`);
    console.log(`list 父元素: <${r.listAttrs.parentTag}> class="${r.listAttrs.parentCls}"`);
  }
  console.log(`\n结果项内文本样本:`);
  r.samples.forEach((texts, i) => {
    console.log(`  --- 第 ${i + 1} 项 ---`);
    texts.forEach((t) => console.log(`    ${t}`));
  });
} catch (e) {
  console.log(`注入失败: ${e.message}`);
}
