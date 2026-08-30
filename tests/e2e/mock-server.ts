// E2E mock LLM 服务器：Anthropic 兼容端点的最小实现（SSE 流 + JSON 非流 +
// /v1/models + count_tokens）。零依赖（node:http）。
// 响应按「场景脚本」驱动：每个请求进 handler，handler 依据请求体特征（是否已带
// tool_result）选择下一步回复——服务端同时记录全部请求体，供 runner 做协议契约
// 断言（如 tool_result 必须回传）。

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** 一段回复的内容块序列（thinking/text/tool_use） */
export interface ReplyScript {
  thinking?: string;
  text?: string;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
}

export interface MockServer {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 把一段回复编成 Anthropic SSE 流写出 */
function writeStreamReply(res: ServerResponse, model: string, script: ReplyScript, stopReason: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  // message_start 必须带 content: []——SDK 的 MessageStream 会在 snapshot.content 上
  // push 内容块，缺字段直接 TypeError（真实 API 恒带）
  sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } });
  let index = 0;
  if (script.thinking) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
    for (const chunk of [script.thinking.slice(0, Math.ceil(script.thinking.length / 2)), script.thinking.slice(Math.ceil(script.thinking.length / 2))]) {
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: chunk } });
    }
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'e2e-sig' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  if (script.text && stopReason !== 'tool_use') {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: script.text } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  if (script.toolCall) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: script.toolCall.id, name: script.toolCall.name, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(script.toolCall.input) } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 20 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function writeJsonReply(res: ServerResponse, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'msg_e2e_json', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 },
  }));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { return {}; }
}

export interface MockHandlers {
  model: string;
  /** 流式对话请求：按请求体返回下一个回复脚本与 stop_reason */
  onStreamRequest: (body: Record<string, unknown>, n: number) => { script: ReplyScript; stopReason: string };
  /** 非流式请求（title 生成等）：返回纯文本 */
  onJsonRequest: (body: Record<string, unknown>) => string;
}

export async function startMockServer(h: MockHandlers): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let streamN = 0;

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', path: req.url ?? '', body });
    try {
      if (req.url?.endsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1234 }));
        return;
      }
      if (req.url?.endsWith('/v1/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: h.model, created: '2026-01-01T00:00:00Z' }], has_more: false }));
        return;
      }
      if (req.url?.endsWith('/v1/messages') && req.method === 'POST') {
        if (body.stream === true) {
          streamN++;
          const { script, stopReason } = h.onStreamRequest(body, streamN);
          writeStreamReply(res, String(body.model ?? h.model), script, stopReason);
        } else {
          writeJsonReply(res, String(body.model ?? h.model), h.onJsonRequest(body));
        }
        return;
      }
      res.writeHead(404); res.end('{}');
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    requests,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
