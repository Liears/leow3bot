// 共享类型（Anthropic messages 格式 + UI 视图模型）

export type Role = 'user' | 'assistant';

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ImageBlock | ToolResultBlock;
export type MessageContent = string | ContentBlock[];

export interface MessageParam { role: Role; content: MessageContent }

export interface Usage { input_tokens?: number; output_tokens?: number; [k: string]: unknown }
export interface Timing { ttft: number | null; decode_time: number | null; total: number }

export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

// callLLMStream yield 的 5 种事件（对齐 Python llm.py）
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; assistant_msg: MessageParam; tool_calls: ToolCall[]; usage: Usage | null; timing: Timing }
  | { type: 'done'; assistant_msg: MessageParam; usage: Usage | null; timing: Timing }
  | { type: 'interrupted'; assistant_msg: MessageParam; usage: Usage | null; timing: Timing };

// 进 <Static> 的条目（只增，进原生 scrollback）
export type CommittedItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant_line'; text: string; code?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'thinking_line'; text: string }
  | { kind: 'tool_start'; call: ToolCall }
  | { kind: 'tool_result'; call: ToolCall; result: unknown }
  | { kind: 'system'; text: string; tone: 'ok' | 'err' | 'warn' | 'muted' }
  | { kind: 'logo'; logo: string[]; name: string };

// StatusBar 常驻的启动元信息（model / 工具数 / cwd 等）
export interface Meta { model: string; nTools: number; nSkills: number; cwd: string }
