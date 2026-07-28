// probe：验证 callLLMStream（leow3bot 真实调用路径）的流式 + thinking + usage。
//   配好 config.json 后 npm run probe，看 thinking/text 事件流 + done 的 usage。
import { callLLMStream } from '../llm.js';
import { THINKING_BUDGET } from '../config.js';

async function main() {
  console.log(`THINKING_BUDGET=${THINKING_BUDGET}`);
  const messages = [{ role: 'user' as const, content: '你好' }];
  let thinkN = 0, textN = 0;
  for await (const ev of callLLMStream(messages, [], '', new AbortController().signal)) {
    if (ev.type === 'thinking') { thinkN++; if (thinkN <= 3) console.log('  THINKING:', JSON.stringify(ev.text)); }
    else if (ev.type === 'text') { textN++; if (textN <= 3) console.log('  TEXT:', JSON.stringify(ev.text)); }
    else if (ev.type === 'done') { console.log(`DONE: thinking=${thinkN} chunks, text=${textN} chunks`); console.log('  usage:', JSON.stringify(ev.usage)); break; }
    else console.log('EVENT:', ev.type);
  }
  if (thinkN === 0) console.log('⚠️ 没有 thinking 事件 —— glm 对"你好"没思考');
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
