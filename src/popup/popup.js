/**
 * 弹窗逻辑。
 *
 * 弹窗运行在扩展自己的上下文里，**不是**页面上下文。
 * 所以它不能直接操作页面 DOM，必须通过消息发给内容脚本。
 */
import { getSettings, saveSettings } from '../shared/settings.js';
import { MODES } from '../shared/constants.js';

const el = {
  pageInfo: document.getElementById('pageInfo'),
  modeButtons: [...document.querySelectorAll('.seg')],
  autoTranslate: document.getElementById('autoTranslate'),
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  baseUrl: document.getElementById('baseUrl'),
  glossary: document.getElementById('glossary'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  translateNow: document.getElementById('translateNow'),
  reset: document.getElementById('reset'),
  clearCache: document.getElementById('clearCache'),
  diagnose: document.getElementById('diagnose'),
  status: document.getElementById('status'),
};

/** 显示状态信息 */
function setStatus(message, level = 'info') {
  el.status.textContent = message;
  el.status.setAttribute('data-level', level);
}

/** 取当前活动标签页 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * 向内容脚本发消息。
 * 内容脚本可能不存在（非 GitHub 页面、或扩展刚装还没刷新页面），
 * 这时 chrome.runtime.lastError 会被设置，需要明确告知用户该怎么做。
 */
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ ok: false, error: lastError.message, noContentScript: true });
        return;
      }
      resolve(response || { ok: false, error: '无响应' });
    });
  });
}

/** 把设置渲染到界面 */
function render(settings) {
  el.apiKey.value = settings.apiKey || '';
  el.model.value = settings.model || '';
  el.baseUrl.value = settings.baseUrl || '';
  el.glossary.value = settings.glossary || '';
  el.autoTranslate.checked = Boolean(settings.autoTranslate);
  for (const btn of el.modeButtons) {
    btn.classList.toggle('active', btn.dataset.mode === settings.mode);
  }
}

/** 读取表单上的设置 */
function readForm() {
  return {
    apiKey: el.apiKey.value.trim(),
    model: el.model.value.trim() || 'deepseek-flash',
    baseUrl: el.baseUrl.value.trim() || 'https://api.deepseek.com/v1',
    glossary: el.glossary.value,
    autoTranslate: el.autoTranslate.checked,
  };
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

// 模式切换：立即保存并生效，不需要点"保存"
for (const btn of el.modeButtons) {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    for (const b of el.modeButtons) b.classList.toggle('active', b === btn);
    await saveSettings({ mode });
    setStatus(
      mode === MODES.OFF
        ? '已关闭翻译，页面将复原。'
        : `已切换到「${btn.textContent}」模式。`,
      'info'
    );
  });
}

// 自动翻译开关
el.autoTranslate.addEventListener('change', async () => {
  await saveSettings({ autoTranslate: el.autoTranslate.checked });
  setStatus(el.autoTranslate.checked ? '已开启自动翻译（注意费用）。' : '已关闭自动翻译。', 'info');
});

// 保存 API 配置
el.save.addEventListener('click', async () => {
  await saveSettings(readForm());
  setStatus('已保存。', 'success');
});

// 测试连接
el.test.addEventListener('click', async () => {
  const form = readForm();
  if (!form.apiKey) {
    setStatus('请先填写 API Key 再测试。', 'warning');
    return;
  }
  el.test.disabled = true;
  setStatus('正在测试连接…', 'info');
  // 先把表单存下来，后台是从 storage 读设置的
  await saveSettings(form);

  chrome.runtime.sendMessage(
    { type: 'GHST_TEST_CONNECTION', settingsOverride: form },
    (response) => {
      el.test.disabled = false;
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        setStatus(`无法连接后台服务：${lastError.message}`, 'error');
        return;
      }
      if (response?.ok) {
        setStatus(`连接正常。示例：Hello world → ${response.sample}`, 'success');
      } else {
        setStatus(`连接失败：${response?.error || '未知错误'}`, 'error');
      }
    }
  );
});

// 翻译此页
el.translateNow.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) {
    setStatus('找不到活动标签页。', 'error');
    return;
  }

  setStatus('正在翻译，请稍候…', 'info');
  const response = await sendToTab(tab.id, { type: 'GHST_TRANSLATE_NOW' });

  // 不依赖 tab.url 判断（权限受限时 url 可能为空），
  // 而是以"内容脚本是否存在"为准 —— 内容脚本只注入 github.com，
  // 所以它没响应就说明当前不是 GitHub 页面。
  if (response.noContentScript) {
    setStatus(
      '内容脚本没有响应。请依次检查：\n' +
        '1. 当前标签页是 github.com（顶部地址栏确认）\n' +
        '2. 按 F5 刷新该页面（扩展重载后必须刷新）\n' +
        '3. 到 edge://extensions/ 点本扩展的「重新加载」\n' +
        '4. 若涉及 GitHub 首页，试着打开任一仓库页再点此处\n' +
        '若以上都做过仍不行，把这段原样发我。',
      'warning'
    );
    return;
  }
  if (response.ok) {
    const s = response.stats || {};
    setStatus(
      `完成：新翻译 ${s.translated ?? 0} 条，缓存命中 ${s.fromCache ?? 0} 条` +
        (s.failed ? `，失败 ${s.failed} 条` : ''),
      s.failed ? 'warning' : 'success'
    );
  } else {
    setStatus(`翻译失败：${response.error || '未知错误'}`, 'error');
  }
});

// 复原页面
el.reset.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const response = await sendToTab(tab.id, { type: 'GHST_RESET' });
  if (response.noContentScript) {
    setStatus('当前页面没有运行扩展（请确认是 GitHub 页面）。', 'warning');
  } else {
    setStatus('已移除全部译文，页面已复原。', 'success');
  }
});

// 清空缓存
el.clearCache.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  // IndexedDB 在页面上下文里，所以必须让内容脚本去清
  const response = await sendToTab(tab.id, { type: 'GHST_CLEAR_CACHE' });
  if (response.noContentScript) {
    setStatus('请在 GitHub 页面上执行清空缓存。', 'warning');
    return;
  }
  setStatus('已清空该站点下的译文缓存。', 'success');
});

// 诊断：不发任何网络请求，只报告"扩展在当前页面看到了什么"
el.diagnose.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) {
    setStatus('找不到活动标签页。', 'error');
    return;
  }
  const res = await sendToTab(tab.id, { type: 'GHST_DIAGNOSE' });

  if (res.noContentScript) {
    setStatus('当前页面没有运行扩展（不是 GitHub 页面，或需要按 F5 刷新）。', 'warning');
    return;
  }
  if (!res.ok) {
    setStatus(`诊断失败：${res.error || '未知错误'}`, 'error');
    return;
  }

  const r = res.report || {};
  const lines = [];
  lines.push(`页面类型：${res.pageContext?.type || '未知'}`);
  if (res.pageContext?.repo) lines.push(`仓库：${res.pageContext.repo.fullName}`);
  lines.push(`匹配到的容器：${r.containerCount ?? 0} 个`);
  lines.push(`模式：${r.usedFallback ? '降级（未命中主选择器，正在用兜底）' : '正常'}`);
  lines.push(`将翻译的文本节点：${res.scannedNodes ?? 0} 条`);

  if (Array.isArray(r.matchedSelectors) && r.matchedSelectors.length) {
    lines.push('命中的选择器：');
    for (const m of r.matchedSelectors.slice(0, 8)) {
      lines.push(`  · ${m.selector} × ${m.count}`);
    }
  } else {
    lines.push('命中的选择器：（无）');
  }

  if (Array.isArray(r.sample) && r.sample.length) {
    lines.push('待翻译样本：');
    for (const s of r.sample) lines.push(`  · ${s}`);
  }

  setStatus(lines.join('\n'), (res.scannedNodes ?? 0) > 0 ? 'success' : 'warning');
});

/* ------------------------------------------------------------------ */
/* 初始化                                                             */
/* ------------------------------------------------------------------ */

(async function init() {
  const settings = await getSettings();
  render(settings);

  const tab = await getActiveTab();
  if (!tab) {
    el.pageInfo.textContent = '打开一个 GitHub 页面后使用';
    setStatus('提示：先打开 GitHub 页面，再点「翻译此页」。', 'info');
    return;
  }

  // 以内容脚本是否在运行来判断当前是不是 GitHub 页面（不依赖 tab.url 权限）
  const status = await sendToTab(tab.id, { type: 'GHST_STATUS' });

  if (status?.ok) {
    const path = (tab.url || '').replace('https://github.com', '') || '';
    const repo = status.pageContext?.repo?.fullName;
    el.pageInfo.textContent = repo ? `${repo}${path}` : path || 'GitHub 页面';

    if (status.bootError) {
      setStatus(`内容脚本启动时出错：${status.bootError}`, 'error');
    } else if (!status.booted) {
      setStatus('内容脚本已在运行，但尚未完成初始化。稍等 1 秒再点「翻译此页」。', 'warning');
    } else {
      setStatus(
        `内容脚本就绪。已注入 ${status.injected} 条译文。` +
          (status.pageContext?.type ? `页面类型：${status.pageContext.type}` : ''),
        'info'
      );
    }
  } else {
    el.pageInfo.textContent = '打开一个 GitHub 页面后使用';
    setStatus(
      '内容脚本未响应。\n' +
        '1. 确认当前标签页是 github.com\n' +
        '2. 按 F5 刷新该页面\n' +
        '3. 到 edge://extensions/ 点本扩展的「重新加载」',
      'warning'
    );
  }

  if (!settings.apiKey) {
    setStatus(
      '尚未填写 API Key —— 没有 Key 无法调用翻译。请填入 DeepSeek API Key 后点「测试连接」。',
      'warning'
    );
  }
})();
