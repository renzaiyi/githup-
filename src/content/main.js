/**
 * 内容脚本入口：把各个模块串起来。
 *
 * 流程：
 *   读取设置 → 判断模式 → 收集文本节点 → 查缓存 → 批量翻译 → 注入译文 → 监听动态内容
 */
import { MODES, BATCH_SIZE, MAX_CONCURRENCY, PROMPT_VERSION } from '../shared/constants.js';
import { getSettings, onSettingsChanged } from '../shared/settings.js';
import { buildPageContext, buildContextKey, getContentStrategy, detectPageType } from '../shared/github-context.js';
import { getCached, setCachedMany, clearCache } from '../shared/cache.js';
import { cacheKey, chunk, mapWithConcurrency } from '../shared/util.js';
import { injectStyles, STYLE_ID } from '../core/styles.js';
import {
  collectTextNodes,
  findContentContainers,
  getLastReport,
  injectTranslation,
  applyMode,
  removeAllTranslations,
  countInjected,
} from '../core/dom.js';

const TARGET_LANG = 'zh-CN';

const state = {
  settings: null,
  contextKey: '',
  pageContext: null,
  running: false,
  pending: false,
  observer: null,
  debounceTimer: null,
  booted: false,
  bootError: null,
  stats: { total: 0, fromCache: 0, translated: 0, failed: 0 },
};

/**
 * 通过 Service Worker 发翻译请求。
 *
 * 【关键】不能在这里直接 fetch —— 内容脚本的 fetch 受 github.com 的 CORS 策略约束，
 * 会被浏览器拦截。必须交给有 host_permissions 的后台去做。
 *
 * @param {Array<{i:number,text:string}>} items
 * @returns {Promise<Map<number,string>>}
 */
function requestTranslation(items) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'GHST_TRANSLATE',
        items,
        pageContext: state.pageContext,
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(`无法连接后台服务：${lastError.message}`));
          return;
        }
        if (!response) {
          reject(new Error('后台服务无响应'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || '翻译失败'));
          return;
        }
        resolve(new Map(response.translations));
      }
    );
  });
}

/** 初始化页面上下文（不涉及网络，无需后台） */
function initContext() {
  state.pageContext = buildPageContext();
  state.contextKey = buildContextKey();
}

/**
 * 翻译整个页面（增量：已在缓存里的直接注入，未命中的发请求）。
 */
async function translatePage({ silent = false } = {}) {
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  state.stats = { total: 0, fromCache: 0, translated: 0, failed: 0 };

  try {
    // 消息可能在 boot() 完成之前就到达（模块化内容脚本是异步加载的），
    // 所以这里补齐 settings 与页面上下文，避免出现 undefined.model 之类的崩溃。
    if (!state.settings) {
      state.settings = await getSettings();
    }
    if (!state.pageContext) {
      initContext();
    }
    if (!document.getElementById(STYLE_ID)) {
      injectStyles();
    }

    // 先找容器，拿到诊断信息（选择器命中情况）。
    // 这一步纯本地计算，不花任何 token。
    // 策略分流：搜索页用专用选择器；目录页/代码页没有正文 → 禁用兜底。
    const strategy = getContentStrategy(state.pageContext?.type);
    const report = findContentContainers({
      fallbackAllowed: strategy.allowFallback,
      useSearchSelectors: strategy.useSearchSelectors,
    });
    const nodes = collectTextNodes({ report });
    if (nodes.length === 0) {
      const diag = getLastReport();
      const pageType = state.pageContext?.type || '未知';
      let why;
      if (diag?.fallbackBlocked) {
        why =
          `当前页面类型是「${pageType}」，这是 GitHub 的应用/列表页面，` +
          `没有正文内容。请打开一个仓库页面（例如 github.com/vuejs/core）或某个 Issue / PR 再试。` +
          `\n（界面上的按钮和菜单标签需要靠 github-chinese 词库那套方案，本扩展只翻正文。）`;
      } else {
        why =
          `匹配到 ${diag?.containerCount ?? 0} 个正文容器，但里面没有需要翻译的英文文本` +
          `（可能是内容已经是中文、或全是代码与标识符）。`;
      }
      notify(why, 'warning');
      return;
    }

    state.stats.total = nodes.length;

    // 1. 计算缓存键并查缓存
    const items = [];
    const cacheHits = [];

    for (const entry of nodes) {
      const key = cacheKey({
        text: entry.text,
        contextKey: state.contextKey,
        targetLang: TARGET_LANG,
        promptVersion: PROMPT_VERSION,
        model: state.settings.model,
      });
      const cached = await getCached(key);
      if (typeof cached === 'string') {
        injectTranslation(entry.nodes, cached);
        state.stats.fromCache++;
      } else {
        items.push({ nodes: entry.nodes, text: entry.text, key });
      }
    }

    notify(
      `缓存命中 ${state.stats.fromCache} 条，需翻译 ${items.length} 条`,
      'info'
    );

    if (items.length === 0) {
      applyMode(state.settings.mode);
      notify('全部命中缓存，未产生 API 费用', 'success');
      return;
    }

    // 2. 分批 + 限并发
    const batches = chunk(items, BATCH_SIZE);
    let batchIndex = 0;

    await mapWithConcurrency(batches, MAX_CONCURRENCY, async (batch) => {
      const requestItems = batch.map((item, idx) => ({ i: idx, text: item.text }));
      try {
        const result = await requestTranslation(requestItems);
        const toCache = [];
        batch.forEach((item, idx) => {
          const translation = result.get(idx);
          if (typeof translation === 'string' && translation.trim()) {
            injectTranslation(item.nodes, translation);
            toCache.push([item.key, translation]);
            state.stats.translated++;
          } else {
            state.stats.failed++;
          }
        });
        await setCachedMany(toCache);
        notify(
          `进度 ${Math.round((++batchIndex / batches.length) * 100)}%（本页已翻译 ${state.stats.translated} 条）`,
          'info'
        );
      } catch (error) {
        state.stats.failed += batch.length;
        notify(`翻译失败：${error.message}`, 'error');
      }
    });

    applyMode(state.settings.mode);
    notify(
      `完成：新翻译 ${state.stats.translated} 条，缓存命中 ${state.stats.fromCache} 条` +
        (state.stats.failed > 0 ? `，失败 ${state.stats.failed} 条` : ''),
      state.stats.failed > 0 ? 'warning' : 'success'
    );
  } finally {
    state.running = false;
    if (state.pending) {
      state.pending = false;
      // 有新内容在等待处理，稍后再跑一轮
      setTimeout(() => translatePage({ silent: true }), 800);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 页面提示条（不用 chrome 通知，避免权限与打扰）                       */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function notify(message, level = 'info') {
  let el = document.getElementById('ghst-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ghst-toast';
    el.className = 'ghst-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.setAttribute('data-level', level);
  el.setAttribute('data-visible', '1');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.removeAttribute('data-visible');
  }, level === 'error' ? 8000 : 3500);
}

/* ------------------------------------------------------------------ */
/* 动态内容监听：GitHub 是 React SPA，切 Tab / 展开折叠都会新增内容      */
/* ------------------------------------------------------------------ */

function startObserver() {
  if (state.observer) return;
  state.observer = new MutationObserver((mutations) => {
    // 只关心"新增节点"和"文本变化"，忽略我们自己的注入
    let relevant = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;
          if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('ghst-translation')) continue;
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;

    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      if (state.settings?.mode && state.settings.mode !== MODES.OFF) {
        translatePage({ silent: true });
      }
    }, 1200);
  });

  state.observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  clearTimeout(state.debounceTimer);
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

/**
 * 【关键修复 · 2026-09-22】
 *
 * 消息监听器必须**在最顶层同步注册**，不能放在 async boot() 里面。
 *
 * 原因：manifest 里给内容脚本声明了 "type": "module"，而模块化内容脚本是
 * **异步加载**的。如果监听器注册在 `await getSettings()` 之后，那么
 * 用户点「翻译此页」时监听器可能还没挂上 —— popup 会收到
 * "Could not establish connection"，显示成"当前页面没有运行扩展"。
 * 这正是真机实测暴露出来的 bug：单元测试与静态注入都覆盖不到它。
 *
 * 所以：先同步注册监听器（消息到达时再去读 settings），最后才启动其余逻辑。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  try {
    if (message.type === 'GHST_TRANSLATE_NOW') {
      translatePage()
        .then(() => sendResponse({ ok: true, stats: state.stats }))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) })
        );
      return true; // 异步响应
    }

    if (message.type === 'GHST_RESET') {
      stopObserver();
      removeAllTranslations();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GHST_CLEAR_CACHE') {
      // IndexedDB 属于页面源，所以清缓存也必须由内容脚本执行
      clearCache()
        .then(() => sendResponse({ ok: true, remaining: countInjected() }))
        .catch((error) => sendResponse({ ok: false, error: error?.message }));
      return true;
    }

    if (message.type === 'GHST_STATUS') {
      sendResponse({
        ok: true,
        injected: countInjected(),
        running: state.running,
        pageContext: state.pageContext,
        report: getLastReport(),
        booted: state.booted,
        bootError: state.bootError,
      });
      return true;
    }

    if (message.type === 'GHST_DIAGNOSE') {
      // 现场跑一次检测，把"选择器命中情况 + 会翻译哪些文本"完整回报给 popup。
      // 这一步不发任何网络请求，所以可以放心点。
      const pageType = state.pageContext?.type || detectPageType();
      const strategy = getContentStrategy(pageType);
      const report = findContentContainers({
        fallbackAllowed: strategy.allowFallback,
        useSearchSelectors: strategy.useSearchSelectors,
      });
      const nodes = collectTextNodes({ report });
      sendResponse({
        ok: true,
        url: location.href,
        pageContext: state.pageContext || { type: pageType },
        report: getLastReport(),
        scannedNodes: nodes.length,
      });
      return true;
    }
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || String(error) });
    return true;
  }

  return false;
});

async function boot() {
  state.settings = await getSettings();
  injectStyles();
  initContext();
  state.booted = true;

  if (state.settings.mode !== MODES.OFF) {
    if (state.settings.autoTranslate) {
      // 等待 GitHub 的首屏渲染完成
      setTimeout(() => translatePage({ silent: true }), 1500);
    }
    startObserver();
  }

  // 监听设置变化（popup 里改了模式/key 立即响应）
  onSettingsChanged((patch) => {
    Object.assign(state.settings, patch);
    initContext();

    if (patch.mode === MODES.OFF) {
      stopObserver();
      removeAllTranslations();
      notify('已关闭翻译，页面已复原', 'info');
      return;
    }

    if (patch.mode) {
      applyMode(patch.mode);
    }

    if (patch.apiKey || patch.model || patch.baseUrl || patch.glossary) {
      // 关键配置变了，之前失败的译文值得重试
      notify('配置已更新，重新翻译中…', 'info');
      startObserver();
      translatePage({ silent: true });
    } else if (patch.mode) {
      startObserver();
      translatePage({ silent: true });
    }
  });

  // GitHub 是 SPA，URL 变化时上下文也变了（比如从仓库首页点进某个 Issue）。
  //
  // 【为什么不用 setInterval 轮询】
  // 轮询有两个坏处：① 永远有一个定时器挂着，会阻止测试进程退出；
  // ② 最长要等一个轮询周期才反应。改用事件驱动 + observer，两种情况都更好。
  setupUrlChangeListener();
}

/**
 * 监听 SPA 导航。三种情况都要覆盖：
 *   1. 浏览器前进/后退 → popstate
 *   2. pushState/replaceState（GitHub 主要用这个）→ 需要包装原方法
 *   3. 兜底 → 观察 document.title 变化（SPA 导航几乎必然改标题）
 */
function setupUrlChangeListener() {
  let lastUrl = location.href;

  const onUrlMaybeChanged = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    initContext();
    if (state.settings?.mode !== MODES.OFF) {
      startObserver();
      if (state.settings?.autoTranslate) {
        setTimeout(() => translatePage({ silent: true }), 1200);
      }
    }
  };

  window.addEventListener('popstate', onUrlMaybeChanged);

  // 包装 history 方法，捕获 pushState / replaceState
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function patched(...args) {
      const result = original.apply(this, args);
      // 让 GitHub 自己的处理先跑完再检查
      setTimeout(onUrlMaybeChanged, 0);
      return result;
    };
  }

  // 兜底：标题变化通常等价于导航完成
  const titleNode = document.querySelector('title');
  if (titleNode) {
    const titleObserver = new MutationObserver(onUrlMaybeChanged);
    titleObserver.observe(titleNode, { childList: true, subtree: true, characterData: true });
  }
}

/**
 * 启动。任何异常都写进 state 并以页面提示条暴露出来 ——
 * 静默失败是最难排查的，所以在最外层兜住并显式报告。
 */
boot().catch((error) => {
  state.bootError = error?.message || String(error);
  console.error('[GitHub 智能翻译] 启动失败：', error);
  try {
    injectStyles();
    notify(`扩展启动失败：${state.bootError}`, 'error');
  } catch {
    // 连提示条都插不进去就只能靠 console 了
  }
});
