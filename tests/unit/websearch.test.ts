// web 工具单测（websearch.ts）：mock 全局 fetch，覆盖 searchWeb 结果映射/错误码
// 映射/请求体裁剪，readUrl 的 URL 校验/https 升级/重定向护栏/HTML→markdown/
// content-type 分流。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchWeb, readUrl } from '../../src/websearch.js';

function jsonResponse(obj: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('searchWeb', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      search_result: [
        { title: '结果一', link: 'https://a.com', content: '摘要一', media: 'a.com', publish_date: '2026-01-01' },
        { title: '结果二', link: 'https://b.com', content: '摘要二' },
      ],
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('结果映射 + output 摘要', async () => {
    const r = await searchWeb('智谱 GLM');
    expect(r.type).toBe('web_search');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ title: '结果一', link: 'https://a.com', publish_date: '2026-01-01' });
    expect(r.output).toContain('2 条');
  });

  it('请求体：query 裁剪 70 字符 + 参数透传', async () => {
    await searchWeb('x'.repeat(100), { count: 5, recency: 'oneWeek', domain_filter: 'github.com' });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.search_query).toHaveLength(70);
    expect(body.count).toBe(5);
    expect(body.search_recency_filter).toBe('oneWeek');
    expect(body.search_domain_filter).toBe('github.com');
  });

  it('空 query → 不发请求', async () => {
    const r = await searchWeb('   ');
    expect(r.output).toContain('搜索内容为空');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('智谱错误码 1701 → 中文并发提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: '1701', message: 'rate limit' } })));
    const r = await searchWeb('q');
    expect(r.output).toContain('并发已达上限');
    expect(r.results).toHaveLength(0);
  });

  it('未知错误码 → 通用失败提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: '9999', message: '服务异常' } })));
    const r = await searchWeb('q');
    expect(r.output).toContain('搜索失败');
  });

  it('fetch 抛异常 → 包成错误对象不抛出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await searchWeb('q');
    expect(r.output).toContain('搜索请求错误');
    expect(r.type).toBe('web_search');
  });
});

describe('readUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('URL 无效 → 错误提示', async () => {
    const r = await readUrl('ftp://x.com');
    expect(r.output).toContain('URL 无效');
    const r2 = await readUrl('');
    expect(r2.output).toContain('URL 无效');
  });

  it('http:// 自动升级 https', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } })));
    await readUrl('http://example.com/a');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://example.com/a');
  });

  it('HTML → title 提取 + markdown 转换', async () => {
    const html = '<html><head><title>测试页 &amp; 副标题</title></head><body><h1>大标题</h1><script>bad()</script><p>段落文本</p></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })));
    const r = await readUrl('https://example.com/page');
    expect(r.title).toBe('测试页 & 副标题'); // 实体解码
    expect(r.output).toContain('已读取: 测试页');
    expect(r.content).toContain('# 大标题');    // atx 标题
    expect(r.content).toContain('段落文本');
    expect(r.content).not.toContain('bad()');   // script 剔除
  });

  it('纯文本/json 透传（不做 markdown 转换）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"k":1}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const r = await readUrl('https://example.com/api');
    expect(r.content).toBe('{"k":1}');
  });

  it('不支持的 content-type → 明确错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })));
    const r = await readUrl('https://example.com/bin');
    expect(r.output).toContain('不支持的 content-type');
  });

  it('HTTP 错误状态 → 读取失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const r = await readUrl('https://example.com/404');
    expect(r.output).toContain('读取失败: HTTP 404');
  });

  it('同 host 重定向自动跟随（±www）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://www.example.com/final' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })));
    const r = await readUrl('https://example.com/start');
    expect(r.content).toBe('ok');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('跨 host 重定向停下（SSRF 护栏）并提示用新 URL', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example.net/x' } })));
    const r = await readUrl('https://example.com/redir');
    expect(r.output).toContain('跨域重定向');
    expect(r.content).toContain('https://evil.example.net/x');
    expect(r.content).toContain('重新调用 web_fetch');
  });

  it('协议降级重定向（https→http）不跟随', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://example.com/x' } })));
    const r = await readUrl('https://example.com/redir');
    expect(r.output).toContain('跨域重定向'); // 协议不同 → 同护栏路径
  });
});
