/**
 * 从真实源码生成探针并注入浏览器执行。
 *
 * 【为什么不用硬编码的选择器列表】
 * 如果用副本，验证的就是副本而不是真实代码 —— 那样的"验证"没有意义。
 * 这个脚本直接 import src/shared/constants.js，把真实的
 * CONTENT_SELECTORS / EXCLUDE_UI_SELECTORS / SKIP_TAGS 注入页面。
 *
 * 用法：node scripts/run-probe.js <url>
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_SELECTORS,
  EXCLUDE_SELECTORS,
  SKIP_TAGS,
  FALLBACK_CONTAINER_SELECTORS,
} from '../src/shared/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 生成在页面里执行的探针代码 */
function buildProbe() {
  // 注意：EXCLUDE_SELECTORS 已包含 EXCLUDE_UI_SELECTORS（通过展开合并）
  const payload = {
    contentSelectors: CONTENT_SELECTORS,
    excludeSelectors: EXCLUDE_SELECTORS,
    skipTags: [...SKIP_TAGS],
    fallbackSelectors: FALLBACK_CONTAINER_SELECTORS,
  };

  return `(() => {
  const CFG = ${JSON.stringify(payload)};
  const EXCLUDE_SELECTOR = CFG.excludeSelectors.join(',');
  const SKIP = new Set(CFG.skipTags);
  const q = (sel, root) => { try { return (root || document).querySelectorAll(sel); } catch { return []; } };

  // ---- 1. 内容选择器命中情况 ----
  const contentHits = CFG.contentSelectors.map((sel) => {
    const found = q(sel);
    let excluded = 0;
    for (const el of found) if (el.closest(EXCLUDE_SELECTOR)) excluded++;
    return { sel, total: found.length, kept: found.length - excluded, excluded };
  }).filter((h) => h.total > 0);

  const containers = new Set();
  for (const sel of CFG.contentSelectors) {
    for (const el of q(sel)) {
      if (!el.closest(EXCLUDE_SELECTOR)) containers.add(el);
    }
  }

  // ---- 2. 复刻扩展的文本筛选逻辑 ----
  const looksLikeChinese = (s) => {
    const cjk = (s.match(/[\\u4e00-\\u9fff\\u3400-\\u4dbf]/g) || []).length;
    const letters = (s.match(/[A-Za-z\\u4e00-\\u9fff\\u3400-\\u4dbf]/g) || []).length;
    return letters > 0 && cjk / letters > 0.35;
  };
  const looksLikeIdentifier = (s) => {
    const t = s.trim();
    if (!t) return true;
    if (/^https?:\\/\\/\\S+$/i.test(t)) return true;
    if (/^-{1,2}[A-Za-z][\\w-]*(\\s+-{1,2}[A-Za-z][\\w-]*)*$/.test(t)) return true;
    if (/^[\\w./@-]+$/.test(t) && /[./@]/.test(t) && !/\\s/.test(t)) return true;
    if (/^v?\\d+(\\.\\d+)+([-+][\\w.]+)?$/i.test(t)) return true;
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return true;
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(t)) return true;
    if (/^[\\w$]+(\\(\\)|\\.\\w+|::\\w+)+$/.test(t)) return true;
    return false;
  };

  const collected = [];
  const rejectedSamples = { skipTag: [], excluded: [], chinese: [], identifier: [], tooShort: [] };

  for (const container of containers) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        let cur = parent;
        while (cur) {
          if (SKIP.has(cur.tagName)) return NodeFilter.FILTER_REJECT;
          cur = cur.parentElement;
        }
        if (parent.closest(EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').replace(/\\s+/g, ' ').trim();
      if (t.length < 2) { if (t) rejectedSamples.tooShort.push(t.slice(0, 30)); continue; }
      if (t.length > 4000) continue;
      if (!/[A-Za-z]{2,}/.test(t)) continue;
      if (looksLikeChinese(t)) { rejectedSamples.chinese.push(t.slice(0, 40)); continue; }
      if (looksLikeIdentifier(t)) { rejectedSamples.identifier.push(t.slice(0, 40)); continue; }
      collected.push(t);
    }
  }

  // ---- 3. 安全检查：输入框是否落在内容容器内 ----
  const inputAudit = [];
  for (const el of q('input, textarea, [contenteditable="true"]')) {
    let inside = null;
    for (const c of containers) if (c.contains(el)) { inside = c; break; }
    inputAudit.push({
      tag: el.tagName,
      type: el.type || '',
      placeholder: (el.getAttribute('placeholder') || '').slice(0, 35),
      value: (el.value || '').slice(0, 25),
      insideContentContainer: Boolean(inside),
    });
  }

  // ---- 4. 误杀检查：被排除规则挡掉的 .markdown-body ----
  const killedContent = [];
  for (const el of q('.markdown-body')) {
    const excl = el.closest(EXCLUDE_SELECTOR);
    if (excl) {
      killedContent.push({
        excludedBy: excl.tagName + (excl.className ? '.' + String(excl.className).slice(0, 55) : ''),
        textPreview: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 70),
      });
    }
  }

  // ---- 5. 兜底路径会收集什么（用于对比） ----
  let fallbackCollected = 0;
  if (containers.size === 0) {
    for (const csel of CFG.fallbackSelectors) {
      for (const fc of q(csel)) {
        if (fc.closest(EXCLUDE_SELECTOR)) continue;
        fallbackCollected += q('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, dd, summary', fc).length;
      }
    }
  }

  return JSON.stringify({
    url: location.href,
    title: document.title.slice(0, 70),
    contentHits,
    containerCount: containers.size,
    collectedCount: collected.length,
    samples: collected.slice(0, 8),
    inheritedIdentifierSamples: rejectedSamples.identifier.slice(0, 6),
    chineseSamples: rejectedSamples.chinese.slice(0, 4),
    inputAudit,
    inputsInsideContent: inputAudit.filter((i) => i.insideContentContainer).length,
    killedContent,
    fallbackCollected,
  });
})()`;
}

/** 用 base64 传给 agent-browser，避开 shell 转义 */
function evalInBrowser(code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const out = execFileSync('agent-browser', ['eval', '-b', b64], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: true,
  });
  // agent-browser 返回的是被 JSON 包了一层的字符串
  let parsed = JSON.parse(out.trim());
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

function navigate(url) {
  execFileSync('agent-browser', ['open', url], { encoding: 'utf8', shell: true, stdio: 'pipe' });
  try {
    execFileSync('agent-browser', ['wait', '--load', 'networkidle'], {
      encoding: 'utf8', shell: true, stdio: 'pipe', timeout: 60000,
    });
  } catch {
    // 有些页面永远不 idle，等一下继续
    execFileSync('agent-browser', ['wait', '3000'], { encoding: 'utf8', shell: true, stdio: 'pipe' });
  }
}

/* ------------------------------------------------------------------ */

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('用法: node scripts/run-probe.js <url> [url2 ...]');
  process.exit(1);
}

const report = [];
for (const url of urls) {
  console.log(`\n${'='.repeat(70)}\n探测: ${url}\n${'='.repeat(70)}`);
  try {
    navigate(url);
    const r = evalInBrowser(buildProbe());
    report.push(r);

    console.log(`标题: ${r.title}`);
    console.log(`内容容器: ${r.containerCount} 个   →  可翻译文本: ${r.collectedCount} 条`);
    console.log(`\n命中的内容选择器:`);
    if (r.contentHits.length === 0) console.log('  （无）');
    for (const h of r.contentHits) {
      const flag = h.kept === 0 ? '  ✗ 全部被排除!' : '';
      console.log(`  · ${h.sel}  命中 ${h.total} / 保留 ${h.kept}${flag}`);
    }
    if (r.killedContent.length) {
      console.log(`\n✗ 被排除规则误杀的正文（${r.killedContent.length} 处）:`);
      for (const k of r.killedContent) {
        console.log(`  · 被 "${k.excludedBy}" 排除: "${k.textPreview}"`);
      }
    }
    console.log(`\n输入框安全: 共 ${r.inputAudit.length} 个输入控件，落在内容容器内的 ${r.inputsInsideContent} 个`);
    for (const i of r.inputAudit.slice(0, 4)) {
      console.log(`  · ${i.tag}(${i.type}) placeholder="${i.placeholder}" 在容器内=${i.insideContentContainer}`);
    }
    console.log(`\n待翻译样本:`);
    for (const s of r.samples) console.log(`  · ${s}`);
    if (r.collectedCount === 0 && r.fallbackCollected > 0) {
      console.log(`\n⚠ 主选择器无结果，兜底可收集 ${r.fallbackCollected} 个段落级元素`);
    }
  } catch (e) {
    console.log(`探测失败: ${e.message}`);
    report.push({ url, error: e.message });
  }
}

writeFileSync(join(ROOT, 'probe-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n完整报告已写入 probe-report.json`);
