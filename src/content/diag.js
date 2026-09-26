/**
 * 最小诊断内容脚本（经典脚本，零依赖，不使用 ES module）。
 *
 * 目的：把问题一刀切开。
 *   - 如果这个脚本能在页面上留下标记 → 内容脚本注入本身没问题，
 *     那 v0.1.1 的失败就是"模块化内容脚本"加载的问题。
 *   - 如果连这个标记都不出现 → 是注入/权限/匹配层面的问题，与代码无关。
 *
 * 它同时完整复刻了 popup 需要的全部消息响应，因此在诊断期间
 * 「翻译此页」等按钮不会报"没有运行扩展"，便于继续排查。
 */
(function () {
  'use strict';

  var MARK = 'ghst-diag-marker';
  var LOG = 'ghst-diag-log';

  // ---- 页面可见标记 ----
  try {
    var marker = document.createElement('div');
    marker.id = MARK;
    marker.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
      'background:#1f6feb', 'color:#fff', 'font:12px/1.5 "Microsoft YaHei",sans-serif',
      'padding:8px 12px', 'border-radius:8px', 'max-width:420px',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'white-space:pre-wrap',
    ].join(';');
    marker.textContent =
      '✅ 内容脚本已注入（诊断模式 v0.1.2-diag）\n' +
      'URL: ' + location.href + '\n' +
      '容器命中: ' + safeCount() + ' 个';
    (document.body || document.documentElement).appendChild(marker);

    // 30 秒后自动淡出，避免一直挡着页面
    setTimeout(function () {
      marker.style.transition = 'opacity .6s';
      marker.style.opacity = '0';
      setTimeout(function () { marker.remove(); }, 700);
    }, 30000);
  } catch (e) {
    console.error('[ghst-diag] 插入标记失败：', e);
  }

  function safeCount() {
    try {
      var sels = ['.markdown-body', '[class*="SharedMarkdownContent"]', '[data-testid="issue-body"]'];
      var n = 0;
      for (var i = 0; i < sels.length; i++) {
        n += document.querySelectorAll(sels[i]).length;
      }
      return n;
    } catch (e) {
      return '查询失败: ' + e.message;
    }
  }

  // ---- 记录注入时间，供 popup 判断 ----
  try {
    window.__ghstDiag = { injectedAt: Date.now(), url: location.href };
  } catch (e) { /* 页面可能冻结 window，忽略 */ }

  console.log('[ghst-diag] 内容脚本已注入', location.href, '容器数=', safeCount());

  // ---- 消息响应（与正式版协议一致）----
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || typeof message.type !== 'string') return false;

      if (message.type === 'GHST_STATUS') {
        sendResponse({
          ok: true,
          injected: 0,
          running: false,
          pageContext: { type: 'diag', repo: null },
          report: null,
          booted: true,
          bootError: null,
          diag: true,
        });
        return true;
      }

      if (message.type === 'GHST_DIAGNOSE') {
        var containers = 0;
        var hits = [];
        var sels = [
          '.markdown-body', 'article.markdown-body',
          '[class*="SharedMarkdownContent"]', '[class*="DirectoryRichtextContent"]',
          '[data-testid="issue-body"]', '[data-testid="release-body"]',
          '[data-testid="discussion-body"]', '.comment-body', '.js-comment-body',
        ];
        for (var i = 0; i < sels.length; i++) {
          var f = document.querySelectorAll(sels[i]);
          if (f.length) {
            hits.push({ selector: sels[i], count: f.length });
            containers += f.length;
          }
        }
        sendResponse({
          ok: true,
          url: location.href,
          pageContext: { type: 'diag（诊断模式）', repo: null },
          report: {
            matchedSelectors: hits,
            usedFallback: false,
            fallbackBlocked: false,
            containerCount: containers,
            textNodeCount: 0,
            sample: ['（诊断模式不收集文本，仅验证注入是否成功）'],
          },
          scannedNodes: 0,
          diag: true,
        });
        return true;
      }

      if (message.type === 'GHST_TRANSLATE_NOW') {
        sendResponse({
          ok: false,
          error: '当前运行的是【诊断模式】（v0.1.2-diag），只验证注入，不执行翻译。' +
            '说明内容脚本注入成功 —— 请把此结果告知，随后换回正式版。',
        });
        return true;
      }

      if (message.type === 'GHST_RESET' || message.type === 'GHST_CLEAR_CACHE') {
        sendResponse({ ok: true });
        return true;
      }

      return false;
    });
  } catch (e) {
    console.error('[ghst-diag] 注册消息监听失败：', e);
  }
})();
