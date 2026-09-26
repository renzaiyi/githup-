/**
 * 翻译引擎（网络层）。
 *
 * 运行环境：**只在 Service Worker 里运行**。
 * 原因见 src/background.js 顶部注释 —— 内容脚本直连 API 会被页面 CORS 拦截。
 */
import { buildSystemPrompt, buildUserPrompt } from '../shared/prompts.js';
import { REQUEST_TIMEOUT, MAX_RETRIES } from '../shared/constants.js';
import { sleep } from '../shared/util.js';
import { TranslateError, parseModelOutput, alignToItems } from './parse.js';

export { TranslateError };

export class Translator {
  /**
   * @param {{ apiKey: string, baseUrl: string, model: string, glossary?: string }} settings
   * @param {{ description?: string }} pageContext
   */
  constructor(settings, pageContext) {
    this.apiKey = settings.apiKey;
    this.baseUrl = (settings.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    this.model = settings.model || 'deepseek-flash';
    this.glossary = settings.glossary || '';
    this.pageContext = pageContext || {};
    this.systemPrompt = buildSystemPrompt({
      pageContext: this.pageContext,
      glossary: this.glossary,
    });
  }

  /**
   * 翻译一批片段（带重试）。
   * @param {Array<{i: number, text: string}>} items
   * @returns {Promise<Map<number, string>>}
   */
  async translateBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return new Map();
    if (!this.apiKey) {
      throw new TranslateError('未填写 DeepSeek API Key，请点击扩展图标填写。');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const content = await this.#request(items);
        return alignToItems(parseModelOutput(content), items);
      } catch (error) {
        lastError = error;
        const retriable = error instanceof TranslateError ? error.retriable : true;
        if (!retriable || attempt === MAX_RETRIES) break;
        await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s
      }
    }
    throw lastError || new TranslateError('翻译请求失败');
  }

  async #request(items) {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: buildUserPrompt(items) },
      ],
      temperature: 1.3, // DeepSeek 官方对翻译场景推荐的温度
      stream: false,
      response_format: { type: 'json_object' },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        throw new TranslateError(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`, { retriable: true });
      }
      throw new TranslateError(`网络错误：${error.message}`, { retriable: true });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const status = response.status;
      const retriable = status === 429 || status >= 500;
      let hint = '';
      if (status === 401) hint = '（API Key 无效或已过期）';
      else if (status === 402) hint = '（余额不足，请到 DeepSeek 平台充值）';
      else if (status === 404) hint = `（模型名 "${this.model}" 不存在，请在弹窗里改为当前可用模型名）`;
      else if (status === 429) hint = '（请求过于频繁，将自动降速重试）';
      throw new TranslateError(
        `API 返回 ${status}${hint}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        { retriable, status }
      );
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new TranslateError('API 响应结构异常，未找到 choices[0].message.content', {
        retriable: true,
      });
    }
    return content;
  }
}

/** 测试连通性（popup 里的「测试连接」） */
export async function testConnection(settings) {
  const translator = new Translator(settings, { description: '' });
  const result = await translator.translateBatch([{ i: 0, text: 'Hello world' }]);
  return result.get(0);
}
