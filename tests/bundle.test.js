/**
 * 打包产物的冒烟测试。
 *
 * 【为什么必须做这一层】
 * 单文件打包虽然消除了 import 失败，但引入了新风险：拼接后的代码可能有
 * 重复声明、引用顺序错误、或者 IIFE 里访问未定义的变量。语法检查抓不到这些，
 * 只有在真实 DOM 环境里执行一遍才知道。
 *
 * 这个测试：造一个模拟 GitHub 页面 + 伪造 chrome API，加载 bundle.js，
 * 然后验证 ① 脚本不抛错 ② 消息监听器确实注册了 ③ 能正常响应 popup 的消息。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '../src/content/bundle.js');

/** 造一个带 README 的模拟 GitHub 页面 + 伪造 chrome API */
function makeEnv() {
  const html = readFileSync(join(here, 'fixtures.html'), 'utf8');
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only' });

  const { window } = dom;

  // ---- 伪造 chrome API ----
  const listeners = [];
  const storage = {};

  window.chrome = {
    runtime: {
      id: 'test-extension-id',
      getURL: (p) => `chrome-extension://test/${p}`,
      lastError: undefined,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : Object.values(keys || {})) {
            if (k in storage) out[k] = storage[k];
          }
          return out;
        },
        set: async (obj) => Object.assign(storage, obj),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };

  // ---- 伪造 IndexedDB（缓存层会用到；缺失时应静默降级，这里给它一个抛错版本以验证降级）----
  // 故意不提供 indexedDB，验证 cache.js 的 try/catch 降级是否生效

  return { dom, window, listeners, storage, runBundle: () => {
    const code = readFileSync(BUNDLE, 'utf8');
    // 在 window 上下文里执行，使 document/window/chrome 都能被脚本看到
    window.eval(code);
  } };
}

/** 取第一个消息监听器的响应 */
function sendMessage(listeners, message) {
  return new Promise((resolve) => {
    let handled = false;
    for (const fn of listeners) {
      const ret = fn(message, { id: 'test-extension-id' }, (response) => {
        handled = true;
        resolve(response);
      });
      if (ret === true) return; // 异步响应，等 sendResponse 被调用
    }
    if (!handled) resolve(undefined);
  });
}

/**
 * 每个测试结束后必须关掉 jsdom 窗口。
 * 内容脚本里有 setInterval（监听 SPA 的 URL 变化），jsdom 的 window 不关掉
 * 这个定时器就不会清，Node 进程会被挂住不退出 —— 表现是测试"通过但超时"。
 */
function cleanup(env) {
  try {
    env.window.close();
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */

test('★ bundle.js 能在模拟 GitHub 页面里执行且不抛错', () => {
  const env = makeEnv();
  assert.doesNotThrow(() => env.runBundle(), 'bundle.js 执行时抛错');
});

test('★ bundle.js 同步注册了消息监听器（这是"没有运行扩展"的根因）', () => {
  const env = makeEnv();
  env.runBundle();

  assert.ok(
    env.listeners.length >= 1,
    `应至少注册 1 个消息监听器，实际 ${env.listeners.length} 个 —— ` +
      '如果为 0，popup 就会收到 Could not establish connection'
  );
});

test('bundle.js 能响应 GHST_STATUS', async () => {
  const env = makeEnv();
  env.runBundle();

  const res = await sendMessage(env.listeners, { type: 'GHST_STATUS' });
  assert.ok(res, 'GHST_STATUS 无响应');
  assert.equal(res.ok, true);
  assert.equal(typeof res.injected, 'number');
  assert.equal(typeof res.booted, 'boolean');
});

test('bundle.js 能响应 GHST_DIAGNOSE 并返回真实容器数', async () => {
  const env = makeEnv();
  env.runBundle();

  const res = await sendMessage(env.listeners, { type: 'GHST_DIAGNOSE' });
  assert.ok(res, 'GHST_DIAGNOSE 无响应');
  assert.equal(res.ok, true);
  assert.ok(res.report, '应返回诊断报告');
  assert.ok(
    res.report.containerCount > 0,
    `诊断应找到内容容器，实际 ${res.report.containerCount}`
  );
  assert.ok(res.scannedNodes > 0, `诊断应找到可翻译文本，实际 ${res.scannedNodes}`);
  assert.ok(Array.isArray(res.report.matchedSelectors));
});

test('bundle.js 能响应 GHST_RESET 且不抛错', async () => {
  const env = makeEnv();
  env.runBundle();
  const res = await sendMessage(env.listeners, { type: 'GHST_RESET' });
  assert.ok(res);
  assert.equal(res.ok, true);
});

test('bundle.js 在无 IndexedDB 环境下仍能降级工作（隐私模式）', async () => {
  const env = makeEnv();
  assert.equal(typeof env.window.indexedDB, 'undefined', 'jsdom 默认无 indexedDB');
  env.runBundle();
  const res = await sendMessage(env.listeners, { type: 'GHST_CLEAR_CACHE' });
  assert.ok(res, 'clearCache 在无 IndexedDB 时不应挂起');
  assert.equal(res.ok, true);
});

test('bundle.js 注入了样式表（证明启动流程走完了）', () => {
  const env = makeEnv();
  env.runBundle();
  // boot() 是异步的，给它一个微任务周期
  return new Promise((resolve) => {
    env.window.setTimeout(() => {
      const style = env.window.document.getElementById('ghst-style');
      assert.ok(style, '样式表未注入 —— 说明 boot() 没有执行成功');
      assert.ok(style.textContent.includes('ghst-translation'), '样式内容不正确');
      resolve();
    }, 50);
  });
});
