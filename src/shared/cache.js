/**
 * 译文缓存。
 *
 * 两层结构：
 *   1. 内存 Map —— 当前页面会话内最快，零延迟。
 *   2. IndexedDB —— 跨页面、跨会话持久化。这是省钱的关键：
 *      同一个 README 第二次打开、第二个标签页、明天再看，都是 0 成本 0 延迟。
 *
 * 缓存键 = hash(原文 + 页面上下文 + 目标语言 + 提示词版本 + 模型)
 * 所以：换模型、改提示词 → 旧缓存自动失效，不会串味。
 */

const DB_NAME = 'ghst-cache';
const DB_VERSION = 1;
const STORE = 'translations';

/** 内存层 */
const memory = new Map();

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('byTime', 'time');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** 读一条缓存（先内存，后 IndexedDB） */
export async function getCached(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result?.value);
      req.onerror = () => reject(req.error);
    });
    if (typeof value === 'string') {
      memory.set(key, value);
      return value;
    }
  } catch {
    // IndexedDB 不可用（隐私模式等）时静默降级为纯内存缓存
  }
  return undefined;
}

/** 写一批缓存：memory 立即写，IndexedDB 异步写 */
export async function setCachedMany(entries) {
  const time = Date.now();
  for (const [key, value] of entries) {
    memory.set(key, value);
  }
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [key, value] of entries) {
        store.put({ key, value, time });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 同上，忽略
  }
}

/** 统计缓存条数 */
export async function countCached() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memory.size;
  }
}

/** 清空缓存（popup 里提供按钮） */
export async function clearCache() {
  memory.clear();
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 忽略
  }
}
