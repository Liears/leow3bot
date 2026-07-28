// 智谱原生 web 工具封装（零新依赖，Node 内置 fetch）。
// searchWeb: POST /paas/v4/web_search —— 联网搜索，返回结构化结果
// readUrl:   POST /paas/v4/reader    —— 网页阅读，服务端 HTML→markdown（能搞定 JS 渲染页）
// 与 apiKey 同平台同 key，错误不抛、包成带 type 的对象返回（对齐 runBash 风格）。

import {
  WEB_SEARCH_URL,
  WEB_SEARCH_ENGINE,
  WEB_SEARCH_CONTENT_SIZE,
  WEB_SEARCH_COUNT,
  WEB_RESULT_MAX_CHARS,
  getWebApiKey,
} from './config.js';
import TurndownService from 'turndown';
// 注：turndown 内部依赖 @mixmark-io/domino 解析 HTML，无需直接 import（其 .d.ts 声明的是 'domino' 裸模块，与包名不匹配）

const SEARCH_TIMEOUT_MS = 60_000;
const READER_TIMEOUT_MS = 60_000;

// 智谱错误码（1701/1702/1703）→ 中文提示
function mapSearchError(code: string, message: string): string {
  if (code === '1701') return '网络搜索并发已达上限，请稍后重试或减少并发';
  if (code === '1702') return '系统未找到可用的搜索引擎服务，请检查配置';
  if (code === '1703') return '搜索引擎未返回有效数据，请调整查询条件';
  return `搜索失败: ${message || code}`;
}

async function postJson<T>(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getWebApiKey()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// web_search
// ============================================================

export interface WebSearchOpts {
  count?: number;
  search_engine?: string;
  content_size?: string;
  recency?: string; // → search_recency_filter
  domain_filter?: string; // → search_domain_filter
}

export interface SearchHit {
  title: string;
  link: string;
  content: string;
  media: string;
  publish_date?: string;
}

export interface WebSearchResult {
  type: 'web_search';
  output: string; // 一句话摘要（供 ⎿ 行显示）
  query: string;
  engine: string;
  results: SearchHit[];
}

interface SearchApiResponse {
  search_result?: Array<{
    title?: string;
    link?: string;
    content?: string;
    media?: string;
    publish_date?: string;
  }>;
  error?: { code?: string; message?: string };
}

export async function searchWeb(query: string, opts: WebSearchOpts = {}): Promise<WebSearchResult> {
  const engine = opts.search_engine || WEB_SEARCH_ENGINE;
  if (!query || !query.trim()) {
    return { type: 'web_search', output: '错误：搜索内容为空', query, engine, results: [] };
  }

  const body: Record<string, unknown> = {
    search_query: query.slice(0, 70), // API 建议 ≤70 字符
    search_engine: engine,
    search_intent: false,
    count: opts.count ?? WEB_SEARCH_COUNT,
    content_size: opts.content_size || WEB_SEARCH_CONTENT_SIZE,
  };
  if (opts.recency) body.search_recency_filter = opts.recency;
  if (opts.domain_filter) body.search_domain_filter = opts.domain_filter;

  try {
    const data = await postJson<SearchApiResponse>(WEB_SEARCH_URL, body, SEARCH_TIMEOUT_MS);
    if (data.error) {
      return { type: 'web_search', output: mapSearchError(data.error.code ?? '', data.error.message ?? ''), query, engine, results: [] };
    }
    const raw = Array.isArray(data.search_result) ? data.search_result : [];
    const results: SearchHit[] = raw.map(r => ({
      title: r.title ?? '',
      link: r.link ?? '',
      content: r.content ?? '',
      media: r.media ?? '',
      ...(r.publish_date ? { publish_date: r.publish_date } : {}),
    }));
    return { type: 'web_search', output: `搜索 "${query}"（${results.length} 条）`, query, engine, results };
  } catch (e) {
    return { type: 'web_search', output: `搜索请求错误: ${(e as Error).message}`, query, engine, results: [] };
  }
}

// ============================================================
// web_fetch（纯客户端抓取，不依赖任何平台 API）
// fetch + 重定向护栏(跨host不跟随,防SSRF) + HTML→markdown(turndown+domino)
// ============================================================

export interface WebFetchResult {
  type: 'web_fetch';
  output: string; // 一句话摘要（仅供 ⎿ 行显示，不进正文）
  url: string;
  title: string; // 仅用于 output 摘要，不进正文
  content: string; // 网页 markdown 全文（已截断到 WEB_RESULT_MAX_CHARS）
}

const FETCH_MAX_REDIRECTS = 10;

// turndown 懒加载单例（对齐 CC，首次抓取才实例化，省内存）
let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
    });
    _turndown.remove(['style', 'script', 'iframe', 'noscript', 'nav', 'header', 'footer', 'aside', 'form']);
  }
  return _turndown;
}

// 重定向护栏（借鉴 CC）：仅同 host（±www、同协议）自动跟随，跨 host 停下防 SSRF/open-redirect
function isSameHostRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.protocol !== b.protocol) return false;
    const strip = (h: string) => h.replace(/^www\./, '');
    return strip(a.hostname) === strip(b.hostname);
  } catch {
    return false;
  }
}

function truncateForOutput(s: string): string {
  return s.length > WEB_RESULT_MAX_CHARS
    ? s.slice(0, WEB_RESULT_MAX_CHARS) + `\n\n[内容过长，已截断。完整共 ${s.length} 字符]`
    : s;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

export async function readUrl(url: string): Promise<WebFetchResult> {
  const base: WebFetchResult = { type: 'web_fetch', output: '', url, title: '', content: '' };
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ...base, output: '错误：URL 无效（需 http/https）' };
  }

  // http → https 升级
  let current = url.startsWith('http://') ? 'https://' + url.slice(7) : url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READER_TIMEOUT_MS);

  try {
    let hops = 0;
    let res: Response | null = null;
    // 手动跟随同 host 重定向；跨 host 停下，提示模型用新 URL 重调
    while (true) {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'MiniClaude/1.0 (+web_fetch)',
          Accept: 'text/html,application/xhtml+xml,text/*,application/json,application/xml,*/*',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        if (hops >= FETCH_MAX_REDIRECTS) return { ...base, output: '错误：重定向次数过多（>10）' };
        const next = new URL(loc, current).toString();
        if (!isSameHostRedirect(current, next)) {
          return {
            ...base,
            output: '跨域重定向（已停止跟随）',
            content: `原始 URL: ${url}\n重定向到: ${next}\n\n请用重定向后的 URL 重新调用 web_fetch。`,
          };
        }
        current = next;
        hops++;
        continue;
      }
      break;
    }

    if (!res || !res.ok) return { ...base, output: `读取失败: HTTP ${res?.status ?? '?'}` };

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let title = '';
    let content: string;

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      const raw = await res.text();
      title = extractTitle(raw); // title 仅用于 output 摘要，不进正文
      content = getTurndown().turndown(raw); // turndown 内部用 domino 解析字符串
    } else if (
      contentType.includes('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript') ||
      contentType.includes('csv')
    ) {
      content = await res.text();
    } else {
      return { ...base, output: `不支持的 content-type: ${contentType || '未知'}（web_fetch 仅处理 HTML/文本）` };
    }

    return { ...base, output: title ? `已读取: ${title}` : `已读取 ${current}`, title, content: truncateForOutput(content) };
  } catch (e) {
    return { ...base, output: `读取请求错误: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
