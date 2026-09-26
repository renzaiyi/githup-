/**
 * 搜索结果项内部结构探针：找出"仓库描述"确切挂在哪个元素上。
 */
import { spawnSync, execFileSync } from 'node:child_process';

function evalInBrowser(code) {
  const res = spawnSync('agent-browser', ['eval', '--stdin'], {
    input: code, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000, shell: true,
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`无输出: ${(res.stderr || '').slice(0, 200)}`);
  let p = JSON.parse(out);
  if (typeof p === 'string') p = JSON.parse(p);
  return p;
}

const PROBE = `(() => {
  const list = document.querySelector('[data-testid="results-list"]');
  if (!list) return JSON.stringify({ error: 'no results-list' });
  const first = list.children[0];

  // 关键：验证候选排除选择器会不会误杀仓库描述
  const CANDIDATES = [
    '[class*="TopicLabel"]',
    'relative-time',
    '[class*="Button"]',
    'button',
    '[role="button"]',
    '[data-testid="results-list"] > div > div:first-child',
  ];
  const descText = 'The library for web and native user interfaces.';
  const affected = CANDIDATES.map((sel) => {
    let n = 0;
    let killsDesc = false;
    try {
      const found = document.querySelectorAll(sel);
      n = found.length;
      for (const el of found) {
        if ((el.textContent || '').includes(descText)) killsDesc = true;
        if (el.querySelector && el.querySelector('*') !== null) {
          // 该元素是否包含描述文本
          for (const d of el.querySelectorAll('*')) {
            if ((d.textContent || '').trim() === descText) killsDesc = true;
          }
        }
        if ((el.textContent || '').trim() === descText) killsDesc = true;
      }
    } catch (e) { /* 非法选择器 */ }
    return { sel, count: n, killsDesc };
  });

  // 描述元素自身的祖先链（判断哪个选择器会命中它的祖先）
  const descEl = Array.from(first.querySelectorAll('span')).find(
    (s) => (s.textContent || '').trim() === descText
  );
  const descChain = [];
  if (descEl) {
    let cur = descEl;
    let d = 0;
    while (cur && d < 6) {
      descChain.push(
        d + ': <' + cur.tagName + '> cls="' + String(cur.className || '').slice(0, 55) + '"'
      );
      cur = cur.parentElement;
      d++;
    }
  }

  return JSON.stringify({ itemCount: list.children.length, affected, descChain, descFound: !!descEl });
})()`;

const url = process.argv[2];
try {
  execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 70000 });
} catch (e) { console.log(`导航警告: ${String(e.message).split('\n')[0]}`); }
try { execFileSync('agent-browser', ['wait', '3500'], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 20000 }); } catch {}

const r = evalInBrowser(PROBE);
console.log(`\n结果项: ${r.itemCount}   找到仓库描述元素: ${r.descFound}`);
console.log(`\n=== 候选排除规则是否误杀仓库描述 ===`);
for (const a of r.affected) {
  const verdict = a.killsDesc ? '\x1b[31m✗ 会误杀描述\x1b[0m' : '\x1b[32m✓ 安全\x1b[0m';
  console.log(`  ${String(a.count).padStart(4)}  ${a.sel}   ${verdict}`);
}
console.log(`\n=== 仓库描述的祖先链 ===`);
for (const c of r.descChain) console.log(`  ${c}`);
