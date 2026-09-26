/**
 * 回真实页面验证「兜底禁用」修复：目录页/代码页不应再收集文件树与按钮。
 *
 * 用真实的 constants.js 与真实的 isFallbackAllowedForPage 逻辑。
 */
import { execFileSync } from 'node:child_process';
import {
  CONTENT_SELECTORS, EXCLUDE_SELECTORS, SKIP_TAGS, FALLBACK_CONTAINER_SELECTORS,
} from '../src/shared/constants.js';
import { detectPageType, isFallbackAllowedForPage } from '../src/shared/github-context.js';

function buildProbe(fallbackAllowed) {
  const cfg = {
    contentSelectors: CONTENT_SELECTORS,
    excludeSelectors: EXCLUDE_SELECTORS,
    skipTags: [...SKIP_TAGS],
    fallbackSelectors: FALLBACK_CONTAINER_SELECTORS,
  };
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const FALLBACK_ALLOWED = ${fallbackAllowed};
  const EX = CFG.excludeSelectors.join(',');
  const SKIP = new Set(CFG.skipTags);
  const q = (s, r) => { try { return (r||document).querySelectorAll(s); } catch { return []; } };

  const containers = new Set();
  for (const s of CFG.contentSelectors) for (const el of q(s)) if (!el.closest(EX)) containers.add(el);

  let usedFallback = false, fallbackBlocked = false;
  if (containers.size === 0) {
    if (!FALLBACK_ALLOWED) { fallbackBlocked = true; }
    else {
      usedFallback = true;
      for (const csel of CFG.fallbackSelectors)
        for (const fc of q(csel)) { if (!fc.closest(EX)) containers.add(fc); }
    }
  }

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

  const FALLBACK_TAGS = new Set(['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','TD','DD','SUMMARY']);
  const collected = [];
  for (const c of containers) {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode(node){
      const p = node.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      let cur = p; while (cur) { if (SKIP.has(cur.tagName)) return NodeFilter.FILTER_REJECT; cur = cur.parentElement; }
      if (p.closest(EX)) return NodeFilter.FILTER_REJECT;
      if (usedFallback && !FALLBACK_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }});
    let n; while ((n = w.nextNode())) {
      const t = (n.nodeValue||'').replace(/\\s+/g,' ').trim();
      if (t.length<2 || t.length>4000) continue;
      if (!/[A-Za-z]{2,}/.test(t)) continue;
      if (looksZh(t) || looksId(t)) continue;
      collected.push(t);
    }
  }
  return JSON.stringify({
    url: location.href,
    containerCount: containers.size,
    usedFallback, fallbackBlocked,
    collectedCount: collected.length,
    samples: collected.slice(0, 10),
  });
})()`;
}

function evalInBrowser(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const out = execFileSync('agent-browser', ['eval', '-b', b64], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: true,
  });
  let parsed = JSON.parse(out.trim());
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

const urls = process.argv.slice(2);
for (const url of urls) {
  const pageType = detectPageType(url);
  const allowed = isFallbackAllowedForPage(pageType);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${url}`);
  console.log(`页面类型: ${pageType}   →  兜底允许: ${allowed}`);
  console.log('='.repeat(72));
  try {
    execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 90000 });
    try {
      execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 45000 });
    } catch { execFileSync('agent-browser', ['wait', '2500'], { encoding: 'utf8', shell: true, stdio: 'pipe' }); }

    const r = evalInBrowser(buildProbe(allowed));
    console.log(`容器 ${r.containerCount} 个   降级=${r.usedFallback}   兜底被禁=${r.fallbackBlocked}`);
    console.log(`可翻译文本: ${r.collectedCount} 条`);
    if (r.collectedCount === 0 && r.fallbackBlocked) {
      console.log('\x1b[32m✓ 正确：该页无正文，兜底已按设计禁用（不再去翻文件树/按钮）\x1b[0m');
    } else if (r.collectedCount > 0) {
      console.log('待翻译样本:');
      for (const s of r.samples) console.log(`  · ${s}`);
    } else {
      console.log('\x1b[33m! 无容器且兜底未被禁 —— 需检查\x1b[0m');
    }
  } catch (e) {
    console.log(`失败: ${e.message}`);
  }
}
