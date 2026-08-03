// 权限管控：危险操作黑名单（内置 + config 自定义 deny）自动拒绝，
// confirm 规则弹交互确认（复用 ask 的 askResolver 机制），
// 「允许并记住」持久化到 ~/.leow3bot/permissions.json（重启生效）。
//
// 判定顺序（安全优先级）：内置 deny → 自定义 deny → 记住的允许 → 自定义 confirm → allow。
// 记住的允许不覆盖 deny：记住条目只可能来自 confirm 规则（deny 命中永不弹框），
// 防止手改 permissions.json 绕过黑名单。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LEOW3BOT_HOME, USER_PERMISSIONS, type PermissionRule } from './config.js';
import { commit, setPhase, setAskResolver } from './store.js';

export type Verdict = 'allow' | 'confirm' | 'deny';

export interface PermissionDecision {
  verdict: Verdict;
  reason?: string; // deny/confirm 时给模型的中文原因
  ruleId?: string; // 命中的规则 id（错误消息诊断用）
}

interface BuiltinRule { id: string; reason: string; re: RegExp }
interface BuiltinPathRule { id: string; reason: string; prefixes: string[] }

// —— 内置 deny：bash 命令（正则，边界 (^|[\s;&|]) / (\s|;|&|\||$)，任意位置可命中，多行/管道链安全）——
const BUILTIN_DENY: BuiltinRule[] = [
  { id: 'rm-root', reason: '删除根目录/当前目录/上级目录（数据不可恢复）', re: /(^|[\s;&|])rm\s+(\S+\s+)*(\/\*?|\.\.\/?|\.)(\s|;|&|\||$)/ },
  { id: 'mkfs', reason: '格式化磁盘/文件系统（数据不可恢复）', re: /(^|[\s;&|])(sudo\s+)?mkfs(\.[a-z0-9]+)?\s/ },
  { id: 'dd-blockdev', reason: 'dd 直接写块设备，可能覆盖磁盘数据', re: /\bdd\b[^;&|]*\bof=\/dev\/(?!null\b)[a-z]/ },
  { id: 'fork-bomb', reason: 'fork 炸弹：无限递归进程耗尽系统资源', re: /(^|[\s;&|])[:a-zA-Z_][a-zA-Z0-9_:]*\s*\(\)\s*\{[^}]*\|[^}]*&\s*\}/ },
  { id: 'poweroff', reason: '关机/重启/休眠系统', re: /(^|[\s;&|])(sudo\s+)?(shutdown|reboot|poweroff|halt)(\s|$)|(^|[\s;&|])systemctl\s+(poweroff|reboot|halt|suspend)/ },
  { id: 'init-runlevel', reason: '切换运行级别（0=关机，6=重启）', re: /(^|[\s;&|])(init|telinit)\s+[06](\s|$)/ },
  { id: 'parted', reason: '磁盘分区/擦除底层操作', re: /(^|[\s;&|])(sudo\s+)?(fdisk|sfdisk|cfdisk|parted|gdisk|wipefs)\s/ },
  { id: 'chmod-root', reason: '修改根目录权限（递归可致系统不可用）', re: /(^|[\s;&|])(sudo\s+)?chmod\s+(-[a-zA-Z]+\s+)*[0-7]{3,4}\s+\/(\s|$)/ },
  { id: 'chown-root', reason: '修改根目录属主（递归可致系统不可用）', re: /(^|[\s;&|])(sudo\s+)?chown\s+(-[a-zA-Z]+\s+)*\S+\s+\/(\s|$)/ },
  { id: 'kill-all', reason: '杀死全部进程', re: /(^|[\s;&|])kill\s+(-9\s+)?-1(\s|$)/ },
  { id: 'redir-blockdev', reason: '重定向直接写入块设备', re: /(^|[\s;&|])[^;&|]*>\s*\/dev\/(?!null\b)(sd|vd|xvd|nvme)[a-z0-9]+/ },
  { id: 'pipe-shell', reason: '管道执行远程脚本（供应链风险）', re: /(^|[\s;&|])(curl|wget)\s+[^;&|]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh)\b/ },
  { id: 'find-delete', reason: '从根目录递归删除文件', re: /(^|[\s;&|])find\s+\/\s+[^;&|]*-delete\b/ },
];

// —— 内置 deny：write/edit 目标路径（前缀匹配）——
const BUILTIN_DENY_PATHS: BuiltinPathRule[] = [
  { id: 'write-dev', reason: '写入设备文件', prefixes: ['/dev/'] },
  { id: 'write-etc', reason: '覆盖系统关键文件', prefixes: ['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/fstab', '/etc/group'] },
];

// —— 自定义规则（config.json permissions.deny/confirm）——
interface CustomRule { pattern: string; re: RegExp | null; reason?: string }
let denyRules: CustomRule[] = [];
let confirmRules: CustomRule[] = [];
let customCompiled = false;

function compileCustomRules(): void {
  if (customCompiled) return;
  customCompiled = true;
  const compile = (list?: PermissionRule[]): CustomRule[] =>
    (list ?? []).map(r => ({
      pattern: r.pattern,
      re: r.mode === 'regex' ? new RegExp(r.pattern) : null,
      reason: r.reason,
    }));
  denyRules = compile(USER_PERMISSIONS.deny);
  confirmRules = compile(USER_PERMISSIONS.confirm);
}

function matchRule(r: CustomRule, target: string): boolean {
  if (r.re) return r.re.test(target);
  return target.startsWith(r.pattern);
}

// —— 记住的允许：~/.leow3bot/permissions.json（env 可覆盖 → 单测隔离）——
const PERMISSIONS_FILE =
  process.env.LEOW3BOT_PERMISSIONS_FILE ?? path.join(LEOW3BOT_HOME, 'permissions.json');

interface RememberedState { version: number; allow: Record<string, string[]> }
let rememberedAllow: Record<string, string[]> = {};
let inited = false;

function ensureInit(): void {
  if (inited) return;
  inited = true;
  try {
    const data = JSON.parse(readFileSync(PERMISSIONS_FILE, 'utf-8')) as RememberedState;
    if (data && typeof data.allow === 'object') rememberedAllow = data.allow;
  } catch { /* 首次运行/文件不存在/损坏 → 空 */ }
  compileCustomRules();
}

function savePermissions(): void {
  try {
    mkdirSync(path.dirname(PERMISSIONS_FILE), { recursive: true });
    writeFileSync(PERMISSIONS_FILE, JSON.stringify({ version: 1, allow: rememberedAllow }, null, 2) + '\n', 'utf-8');
  } catch { /* noop（同 skills.ts） */ }
}

// 记住的允许是前缀匹配；防止记住「rm -rf /tmp/cache/」后被放行「/tmp/cache/..」逃逸
function matchRemembered(tool: string, target: string): boolean {
  const list = rememberedAllow[tool] ?? [];
  return list.some(p => target.startsWith(p) && !target.slice(p.length).startsWith('..'));
}

/**
 * 权限判定。overrides 仅供单测注入自定义规则（不依赖用户 config.json）。
 */
export function checkPermission(
  toolName: string,
  target: string,
  overrides?: { customDeny?: PermissionRule[]; customConfirm?: PermissionRule[] },
): PermissionDecision {
  ensureInit();
  // 1. 内置 deny：bash 正则只对 bash；路径规则只对 write/edit（read 只读不参与）
  if (toolName === 'bash') {
    for (const r of BUILTIN_DENY) if (r.re.test(target)) return { verdict: 'deny', reason: r.reason, ruleId: r.id };
  } else if (toolName === 'write' || toolName === 'edit') {
    for (const r of BUILTIN_DENY_PATHS) if (r.prefixes.some(p => target.startsWith(p))) return { verdict: 'deny', reason: r.reason, ruleId: r.id };
  }
  // 2. 自定义 deny（单测 overrides 优先）
  const cDeny = overrides?.customDeny ? overrides.customDeny.map(r => ({ pattern: r.pattern, re: r.mode === 'regex' ? new RegExp(r.pattern) : null, reason: r.reason })) : denyRules;
  for (const r of cDeny) if (matchRule(r, target)) return { verdict: 'deny', reason: r.reason ?? `命中自定义 deny 规则: ${r.pattern}`, ruleId: 'custom-deny' };
  // 3. 记住的允许（不覆盖 deny）
  if (matchRemembered(toolName, target)) return { verdict: 'allow' };
  // 4. 自定义 confirm
  const cConfirm = overrides?.customConfirm ? overrides.customConfirm.map(r => ({ pattern: r.pattern, re: r.mode === 'regex' ? new RegExp(r.pattern) : null, reason: r.reason })) : confirmRules;
  for (const r of cConfirm) if (matchRule(r, target)) return { verdict: 'confirm', reason: r.reason ?? `命中自定义确认规则: ${r.pattern}`, ruleId: 'custom-confirm' };
  return { verdict: 'allow' };
}

/**
 * 哪些工具参与权限检查的唯一定义点（v1 只查 bash/write/edit；read 只读不改变系统状态，不查。
 * config 里给 read 配的规则 v1 不生效）。未来扩展只加 case。
 */
export function getPermissionTarget(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'bash') return typeof args.command === 'string' ? args.command : null;
  if (toolName === 'write' || toolName === 'edit') return typeof args.path === 'string' ? args.path : null;
  return null;
}

/**
 * 交互确认：复用 store.askResolver（bash/write/edit 均 concurrencySafe:false，
 * 串行路径下任一时刻最多一个挂起，单字段安全）。
 * y=本次允许 / a=允许并记住（写 permissions.json）/ n=拒绝；其他输入重新提示。
 * 结束时恢复 tool_running，堵住「确认通过 → 工具执行期间输入框仍可见」的竞态。
 * 注意：确认挂起时 ESC 无效（与 ask 一致），想退出输 n。
 */
export async function confirmAction(toolName: string, target: string, reason: string): Promise<boolean> {
  setPhase('confirm_pending');
  const shown = target.length > 200 ? target.slice(0, 200) + '…' : target;
  commit({
    kind: 'system', tone: 'warn',
    text: `⚠️ 危险操作需要确认：${toolName}「${shown}」\n原因：${reason}\n（y=本次允许 / a=允许并记住 / n=拒绝）`,
  });
  while (true) {
    const ans = (await new Promise<string>(r => setAskResolver(r))).trim().toLowerCase();
    if (ans === 'y') { setPhase('tool_running'); return true; }
    if (ans === 'a') {
      const list = rememberedAllow[toolName] ?? (rememberedAllow[toolName] = []);
      if (!list.includes(target)) { list.push(target); savePermissions(); }
      setPhase('tool_running');
      return true;
    }
    if (ans === 'n') { setPhase('tool_running'); return false; }
    commit({ kind: 'system', tone: 'warn', text: `无法识别「${ans}」，请输 y / a / n` });
  }
}
