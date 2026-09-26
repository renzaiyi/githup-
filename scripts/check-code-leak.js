/**
 * 代码泄漏检查：在真实页面上确认 PRE / CODE / diff 里的文本没有被收集。
 *
 * 方法：
 *   1. 先按扩展的逻辑收集所有可翻译文本
 *   2. 再单独抓出页面上所有 PRE/CODE/diff 元素的文本，建立"禁词集合"
 *   3. 检查是否有任何收集到的文本落在禁词集合里
 *   4. 额外检查收集到的文本是否有 HTML 标签泄漏、是否包含 diff 特征
 */
import { execFileSync } from 'node:child_process';

function evalInBrowser(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const out = execFileSync('agent-browser', ['eval', '-b', b64], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: true,
  });
  let parsed = JSON.parse(out.trim());
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

const PROBE = `(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA','SELECT','OPTION','PRE','CODE','KBD','SAMP','VAR','SVG','CANVAS','IMG','VIDEO','AUDIO','IFRAME','OBJECT','EMBED','HEAD','TITLE','META','LINK','BASE','RT','RP']);
  const EXCLUDE = ['pre','code','kbd','samp','var','.highlight','.blob-wrapper','.blob-code','table.diff-table','.diff-table','[data-testid="diff"]','header','footer','nav','[role="navigation"]','[role="banner"]','[role="contentinfo"]','[aria-labelledby="folders-and-files"]','#repository-container-header','#repos-file-tree','#diff-content','[contenteditable="true"]','[contenteditable=""]'];
  const CONTENT = ['.markdown-body','article.markdown-body','[class*="SharedMarkdownContent"]','[class*="DirectoryRichtextContent"]','.comment-body','.js-comment-body','[data-testid="issue-body"]','[data-testid="comment-body"]','[data-testid="release-body"]','[data-testid="discussion-body"]','[class*="IssueBody"]','[class*="ReleaseBody"]','[class*="DiscussionBody"]','.release-body','.discussion-body'];
  const EX = EXCLUDE.join(',');
  const q = (s, r) => { try { return (r||document).querySelectorAll(s); } catch { return []; } };

  // 收集
  const containers = new Set();
  for (const s of CONTENT) for (const el of q(s)) if (!el.closest(EX)) containers.add(el);

  const looksZh = (s) => { const c=(s.match(/[\\u4e00-\\u9fff]/g)||[]).length; const l=(s.match(/[A-Za-z\\u4e00-\\u9fff]/g)||[]).length; return l>0 && c/l>0.35; };
  const looksId = (s) => { const t=s.trim(); if(!t) return true;
    if (/^https?:\\/\\/\\S+$/i.test(t)) return true;
    if (/^-{1,2}[A-Za-z][\\w-]*(\\s+-{1,2}[A-Za-z][\\w-]*)*$/.test(t)) return true;
    if (/^[\\w./@-]+$/.test(t) && /[./@]/.test(t) && !/\\s/.test(t)) return true;
    if (/^v?\\d+(\\.\\d+)+([-+][\\w.]+)?$/i.test(t)) return true;
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return true;
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(t)) return true;
    if (/^[\\w$]+(\\(\\)|\\.\\w+|::\\w+)+$/.test(t)) return true;
    return false; };

  const collected = [];
  for (const c of containers) {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode(node){
      const p = node.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      let cur = p; while (cur) { if (SKIP.has(cur.tagName)) return NodeFilter.FILTER_REJECT; cur = cur.parentElement; }
      if (p.closest(EX)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }});
    let n; while ((n = w.nextNode())) {
      const t = (n.nodeValue||'').replace(/\\s+/g,' ').trim();
      if (t.length<2 || t.length>4000) continue;
      if (!/[A-Za-z]{2,}/.test(t)) continue;
      if (looksZh(t) || looksId(t)) continue;
      collected.push(t);
      if (collected.length > 800) break;
    }
  }

  // 页面所有代码文本（作为禁词来源）
  const codeTexts = new Set();
  for (const el of q('pre, code, kbd, samp, table.diff-table, .diff-table, .blob-code, [class*="highlight"]')) {
    const t = (el.textContent||'').replace(/\\s+/g,' ').trim();
    if (t.length >= 8 && t.length <= 400) codeTexts.add(t);
  }

  // 检查泄漏：收集到的文本是否等于/包含某段代码
  const leaks = [];
  for (const t of collected) {
    if (codeTexts.has(t)) { leaks.push({ text: t.slice(0,70), kind: '等于代码块' }); continue; }
    for (const c of codeTexts) {
      if (c.length >= 25 && t.includes(c)) { leaks.push({ text: t.slice(0,70), kind: '包含代码', code: c.slice(0,50) }); break; }
    }
  }

  // 可疑模式：diff 特征、HTML 标签泄漏、代码符号
  const suspicious = collected.filter((t) =>
    /^[-+]{1,3}\\s/.test(t) ||                      // diff 增删行
    /^@@/.test(t) ||                                 // diff hunk 头
    /<[a-z][\\w-]*[^>]*>/i.test(t) ||                // HTML 标签泄漏
    /^\\s*(function|const|let|var|import|export|return|def|class)\\s/.test(t) || // 代码语句
    /[{};]\\s*$/.test(t) && t.length < 40            // 以分号/花括号结尾的短串
  ).slice(0, 12);

  return JSON.stringify({
    url: location.href,
    containerCount: containers.size,
    collectedCount: collected.length,
    codeTextCount: codeTexts.size,
    leakCount: leaks.length,
    leaks: leaks.slice(0, 8),
    suspicious,
    collectedSamples: collected.slice(0, 12),
  });
})()`;

const urls = process.argv.slice(2);
const results = [];
for (const url of urls) {
  console.log(`\n${'='.repeat(70)}\n代码泄漏检查: ${url}\n${'='.repeat(70)}`);
  try {
    execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe' });
    try {
      execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 60000 });
    } catch { execFileSync('agent-browser', ['wait', '3000'], { encoding: 'utf8', shell: true, stdio: 'pipe' }); }

    const r = evalInBrowser(PROBE);
    results.push(r);
    console.log(`容器 ${r.containerCount} 个，收集 ${r.collectedCount} 条文本，页面上有 ${r.codeTextCount} 段代码文本`);
    console.log(r.leakCount === 0
      ? `\x1b[32m✓ 零泄漏：没有任何代码块内容被收集\x1b[0m`
      : `\x1b[31m✗ 发现 ${r.leakCount} 处代码泄漏\x1b[0m`);
    for (const l of r.leaks) console.log(`   · [${l.kind}] "${l.text}"`);
    if (r.suspicious.length) {
      console.log(`\n可疑文本（需人工判断，可能是正文里的行内代码碎片）：`);
      for (const s of r.suspicious) console.log(`   · "${s}"`);
    } else {
      console.log(`\x1b[32m✓ 无可疑的代码特征文本\x1b[0m`);
    }
  } catch (e) {
    console.log(`失败: ${e.message}`);
    results.push({ url, error: e.message });
  }
}
console.log('\n' + '='.repeat(70));
const bad = results.filter((r) => (r.leakCount ?? 1) > 0 || r.error);
console.log(bad.length === 0 ? '\x1b[32m全部页面：零代码泄漏\x1b[0m' : `\x1b[31m${bad.length} 个页面有问题\x1b[0m`);
