/**
 * Service Worker（后台）。
 *
 * 为什么翻译请求必须放在这里，而不是内容脚本里：
 *
 * MV3 的内容脚本运行在宿主页面的源（github.com）下，它的 fetch 受**页面的 CORS 策略**约束。
 * 从 github.com 直接请求 api.deepseek.com，浏览器会因为对方没有返回
 * Access-Control-Allow-Origin 而拦截——表现为"网络错误 / Failed to fetch"。
 *
 * Service Worker 则受扩展的 host_permissions 授权，可以自由跨域请求。
 * 所以：内容脚本负责 DOM，后台负责网络。这个分工是 MV3 的标准做法。
 */
import { Translator, TranslateError, testConnection } from './core/translate.js';
import { getSettings } from './shared/settings.js';

/** 统一响应包装：任何异常都转成结构化结果，不让内容脚本收到未处理的 rejection */
function toErrorPayload(error) {
  const retriable = error instanceof TranslateError ? error.retriable : false;
  return {
    ok: false,
    error: error?.message || String(error),
    retriable,
    status: error instanceof TranslateError ? error.status : 0,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  // ---- 批量翻译 ----
  if (message.type === 'GHST_TRANSLATE') {
    (async () => {
      try {
        const stored = await getSettings();
        // 允许调用方覆盖部分设置（例如临时用不同模型）
        const settings = { ...stored, ...(message.settingsOverride || {}) };
        const translator = new Translator(settings, message.pageContext || {});
        const result = await translator.translateBatch(message.items || []);
        // Map 不能直接过结构化克隆边界 → 转成数组
        sendResponse({ ok: true, translations: [...result.entries()] });
      } catch (error) {
        sendResponse(toErrorPayload(error));
      }
    })();
    return true; // 保持消息通道开启以支持异步响应
  }

  // ---- 测试 API Key ----
  if (message.type === 'GHST_TEST_CONNECTION') {
    (async () => {
      try {
        const stored = await getSettings();
        const settings = { ...stored, ...(message.settingsOverride || {}) };
        const translated = await testConnection(settings);
        sendResponse({ ok: true, sample: translated });
      } catch (error) {
        sendResponse(toErrorPayload(error));
      }
    })();
    return true;
  }

  // ---- 缓存清理（IndexedDB 在页面上下文，这里只做提示） ----
  if (message.type === 'GHST_PING') {
    sendResponse({ ok: true, pong: true });
    return false;
  }

  return false;
});

/** 首次安装时给出引导 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 打开 popup 引导页不现实（MV3 限制），改为打印日志 + 依赖 popup 内的提示
    console.info('[GitHub 智能翻译] 已安装。请点击工具栏图标填写 DeepSeek API Key。');
  }
});
