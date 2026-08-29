/* leow3bot 产品介绍页脚本：安装命令切换/复制 + 场景演示弹层动画 */
(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 安装方式切换 + 复制 ---------- */
  const INSTALL = {
    npm: {
      label: 'npm 安装',
      cmd: 'npm install -g @leow3lab/leow3bot',
    },
    source: {
      label: '从源码安装',
      cmd: 'git clone https://github.com/yuanhechen/leow3bot.git && cd leow3bot && npm i -g .',
    },
  };

  const bar = document.querySelector('.install-bar');
  const labelBtn = document.getElementById('installLabel');
  const labelText = document.getElementById('installLabelText');
  const menu = document.getElementById('installMenu');
  const cmdEl = document.getElementById('installCmd');
  const copyBtn = document.getElementById('copyBtn');

  function setMenuOpen(open) {
    bar.classList.toggle('open', open);
    labelBtn.setAttribute('aria-expanded', String(open));
  }

  labelBtn.addEventListener('click', () => setMenuOpen(!bar.classList.contains('open')));
  document.addEventListener('click', (e) => {
    if (bar.classList.contains('open') && !bar.contains(e.target)) setMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bar.classList.contains('open')) {
      setMenuOpen(false);
      labelBtn.focus();
    }
  });

  menu.querySelectorAll('button[data-install]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const conf = INSTALL[btn.dataset.install];
      if (!conf) return;
      labelText.textContent = conf.label;
      cmdEl.textContent = conf.cmd;
      menu.querySelectorAll('button[data-install]').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      setMenuOpen(false);
      labelBtn.focus();
    });
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  copyBtn.addEventListener('click', async () => {
    if (await copyText(cmdEl.textContent)) {
      copyBtn.classList.add('ok');
      clearTimeout(copyBtn.__t);
      copyBtn.__t = setTimeout(() => copyBtn.classList.remove('ok'), 1600);
    }
  });

  /* ---------- 场景演示弹层 ---------- */
  const DEMOS = {
    paper: {
      file: 'paper.pdf',
      color: '#86abc4',
      label: '论文解析',
      prompt: '解析这篇论文，恢复双栏顺序，保留公式与图注',
      steps: [
        { spin: 1500, text: '读取 paper.pdf · 42 页' },
        { spin: 1400, text: '恢复双栏阅读顺序与跨页引用' },
        { spin: 1600, text: '重建 126 处公式 · 对齐 18 个图注' },
        { ok: '论文解析.md 已写入 · 支持继续追问' },
      ],
    },
    image: {
      file: 'chart.jpg',
      color: '#82b996',
      label: '图片分析',
      prompt: '看看这张图，Q3 为什么突然上涨？',
      steps: [
        { spin: 1400, text: '读取 chart.jpg · 识别图表类型与坐标轴' },
        { spin: 1500, text: '提取 12 个数据点 · 对齐图例' },
        { spin: 1500, text: '分析趋势 → Q3 环比 +42%' },
        { ok: '结论已生成 · 答案支持继续追问' },
      ],
    },
    extract: {
      file: 'scan-202.pdf',
      color: '#c3a271',
      label: '文档提取',
      prompt: '提取这批扫描件里的表格，转成 CSV',
      steps: [
        { spin: 1500, text: '读取 scan-202.pdf · 128 页扫描件' },
        { spin: 1500, text: '定位表格区域 · 识别 12 张表' },
        { spin: 1600, text: '修正倾斜与断行 · 校验数据类型' },
        { ok: 'tables.csv 已导出 · 12 张表 · 0 处错位' },
      ],
    },
    understand: {
      file: 'report.docx',
      color: '#a9a39a',
      label: '文档理解',
      prompt: '总结这份报告的核心结论，并列出风险',
      steps: [
        { spin: 1400, text: '读取 report.docx · 36 页' },
        { spin: 1500, text: '分节归纳要点 · 提取关键数据' },
        { spin: 1500, text: '生成摘要 · 标注 3 处风险提示' },
        { ok: '摘要已写入 · 结论附原文出处' },
      ],
    },
  };

  const modal = document.getElementById('demoModal');
  const titleEl = document.getElementById('demoTitle');
  const fileEl = document.getElementById('demoFileName');
  const fileIcon = document.getElementById('demoFileIcon');
  const mainEl = document.getElementById('demoMain');
  const closeBtn = document.getElementById('demoClose');
  const replayBtn = document.getElementById('demoReplay');

  let playToken = 0;
  let spinTimer = null;
  let currentKey = null;
  let lastTrigger = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function promptLine(text, withCaret) {
    const line = el('div', 'tline');
    line.appendChild(el('span', 'prompt', '❯'));
    line.appendChild(document.createTextNode(' '));
    const typed = el('span', 'typed', text || '');
    line.appendChild(typed);
    if (withCaret) line.appendChild(el('span', 'caret'));
    return line;
  }

  function toolLine(text, mark, markCls) {
    const line = el('div', 'tline');
    line.appendChild(el('span', markCls, mark));
    line.appendChild(document.createTextNode(' '));
    line.appendChild(el('span', 'tool', text));
    return line;
  }

  function renderFinal(conf) {
    mainEl.innerHTML = '';
    mainEl.appendChild(promptLine(conf.prompt, false));
    for (const step of conf.steps) {
      if (step.spin) mainEl.appendChild(toolLine(step.text, '●', 'dim'));
      else mainEl.appendChild(toolLine(step.ok, '✓', 'ok'));
    }
  }

  async function play(key) {
    const conf = DEMOS[key];
    if (!conf) return;
    const my = ++playToken;
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }

    titleEl.textContent = `leow3bot — ${conf.label}演示`;
    fileEl.textContent = conf.file;
    fileIcon.style.background = conf.color;
    mainEl.innerHTML = '';
    replayBtn.disabled = true;

    if (reducedMotion) {
      renderFinal(conf);
      replayBtn.disabled = false;
      return;
    }

    const line = promptLine('', true);
    const typed = line.querySelector('.typed');
    mainEl.appendChild(line);
    for (const ch of conf.prompt) {
      if (my !== playToken) return;
      typed.textContent += ch;
      await sleep(30);
    }
    if (my !== playToken) return;
    await sleep(460);
    if (my !== playToken) return;

    for (const step of conf.steps) {
      if (step.spin) {
        const row = toolLine(step.text, SPIN_FRAMES[0], 'prompt');
        const mark = row.firstChild;
        mainEl.appendChild(row);
        let i = 0;
        spinTimer = setInterval(() => {
          mark.textContent = SPIN_FRAMES[++i % SPIN_FRAMES.length];
        }, 80);
        await sleep(step.spin);
        clearInterval(spinTimer);
        spinTimer = null;
        if (my !== playToken) return;
        mark.textContent = '●';
        mark.className = 'dim';
        await sleep(220);
        if (my !== playToken) return;
      } else {
        await sleep(300);
        if (my !== playToken) return;
        mainEl.appendChild(toolLine(step.ok, '✓', 'ok'));
        await sleep(380);
        if (my !== playToken) return;
      }
    }
    replayBtn.disabled = false;
  }

  function openDemo(key, trigger) {
    if (!DEMOS[key]) return;
    lastTrigger = trigger || null;
    currentKey = key;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
    play(key);
  }

  function closeDemo() {
    playToken++;
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    modal.hidden = true;
    document.body.style.overflow = '';
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
  }

  document.querySelectorAll('.uc-card[data-demo]').forEach((card) => {
    card.addEventListener('click', () => openDemo(card.dataset.demo, card));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDemo(card.dataset.demo, card);
      }
    });
  });

  closeBtn.addEventListener('click', closeDemo);
  modal.querySelector('.demo-backdrop').addEventListener('click', closeDemo);
  replayBtn.addEventListener('click', () => {
    if (currentKey) play(currentKey);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeDemo();
  });
})();
