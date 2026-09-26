/**
 * 搜索页噪声元素溯源：为什么 "JavaScript" / "Updated yesterday" 没被排除？
 * 对每个可疑文本，打印其祖先链并逐条测试排除规则是否命中。
 */
import { spawnSync, execFileSync } from 'node:child_process';

function evalInBrowser(code) {
  const res = spawnSync('agent-browser', ['eval', '--stdin'], {
    input: code, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000, shell: true,
  });
  if (res.error) throw res.error;
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`无输出: ${(res.stderr || '').slice(0, 250)}`);
  let p = JSON.parse(out);
  if (typeof p === 'string') p = JSON.parse(p);
  return p;
}

const PROBE = `(() => {
  const list = document.querySelector('[data-testid="results-list"]');
  if (!list) return JSON.stringify({ error: 'no list' });

  const EXCLUDES = ['[class*="TopicLabel"]','relative-time','[class*="Button"]','button','[role="button"]','svg','img'];
  // 专门看被收集进来的"裸 react" 到底是什么元素
  const bare = [];
  for (const el of list.querySelectorAll('em, mark, [class*="Highlight"], [class*="highlight"]')) {
    bare.push({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 60),
      text: (el.textContent || '').trim().slice(0, 30),
      parentTag: el.parentElement ? el.parentElement.tagName : '',
      parentCls: el.parentElement ? String(el.parentElement.className || '').slice(0, 50) : '',
    });
  }
  return JSON.stringify({ bare: bare.slice(0, 8) });
})()`;

const url = process.argv[2];
try { execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 70000 }); } catch (e) { console.log(`导航警告: ${String(e.message).split('\n')[0]}`); }
try { execFileSync('agent-browser', ['wait', '3500'], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 20000 }); } catch {}

const r = evalInBrowser(PROBE);
console.log(`\n=== 高亮元素（裸 react 的来源）===`);
for (const b of r.bare) {
  console.log(`  <${b.tag}> cls="${b.cls}" ← 父 <${b.parentTag}> cls="${b.parentCls}"`);
  console.log(`      "${b.text}"`);
}
