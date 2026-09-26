/**
 * 设置读写。统一封装，避免各处直接碰 chrome.storage。
 */
import { STORAGE_KEYS, DEFAULT_SETTINGS } from './constants.js';

/** 读取全部设置（带默认值兜底） */
export async function getSettings() {
  const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    apiKey: raw[STORAGE_KEYS.apiKey] ?? DEFAULT_SETTINGS.apiKey,
    model: raw[STORAGE_KEYS.model] ?? DEFAULT_SETTINGS.model,
    baseUrl: raw[STORAGE_KEYS.baseUrl] ?? DEFAULT_SETTINGS.baseUrl,
    mode: raw[STORAGE_KEYS.mode] ?? DEFAULT_SETTINGS.mode,
    autoTranslate: raw[STORAGE_KEYS.autoTranslate] ?? DEFAULT_SETTINGS.autoTranslate,
    glossary: raw[STORAGE_KEYS.glossary] ?? DEFAULT_SETTINGS.glossary,
  };
}

/** 写入部分设置 */
export async function saveSettings(patch) {
  const payload = {};
  if ('apiKey' in patch) payload[STORAGE_KEYS.apiKey] = patch.apiKey;
  if ('model' in patch) payload[STORAGE_KEYS.model] = patch.model;
  if ('baseUrl' in patch) payload[STORAGE_KEYS.baseUrl] = patch.baseUrl;
  if ('mode' in patch) payload[STORAGE_KEYS.mode] = patch.mode;
  if ('autoTranslate' in patch) payload[STORAGE_KEYS.autoTranslate] = patch.autoTranslate;
  if ('glossary' in patch) payload[STORAGE_KEYS.glossary] = patch.glossary;
  await chrome.storage.local.set(payload);
}

/**
 * 监听设置变化。返回取消监听的函数。
 * content script 用它在 popup 改了模式后立即响应。
 */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const [storageKey, field] of Object.entries({
      [STORAGE_KEYS.apiKey]: 'apiKey',
      [STORAGE_KEYS.model]: 'model',
      [STORAGE_KEYS.baseUrl]: 'baseUrl',
      [STORAGE_KEYS.mode]: 'mode',
      [STORAGE_KEYS.autoTranslate]: 'autoTranslate',
      [STORAGE_KEYS.glossary]: 'glossary',
    })) {
      if (storageKey in changes) patch[field] = changes[storageKey].newValue;
    }
    if (Object.keys(patch).length > 0) callback(patch);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
