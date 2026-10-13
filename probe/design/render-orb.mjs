// Render the orb using the CSS that client.js actually ships, so the review
// looks at the shipped rules instead of a hand-made mock-up.
// Usage: node render-orb.mjs    (writes orb-live.html beside this file)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(here, '../../dsh-voice-chat/client.js');
const source = fs.readFileSync(clientPath, 'utf8');

const marker = source.indexOf('const CSS = `');
if (marker < 0) throw new Error('CSS template not found in client.js');
const from = source.indexOf('`', marker) + 1;
const to = source.indexOf('`;', from);
if (to < 0) throw new Error('CSS template is not terminated');
const css = source.slice(from, to);

// Every class the stylesheet targets must exist in the component markup.
const classes = [...new Set([...css.matchAll(/\.dshv[a-z-]*/g)].map((match) => match[0].slice(1)))];
const missing = classes.filter((name) => !source.includes(`'${name}'`) && !source.includes(`"${name}"`));
if (missing.length > 0) {
  throw new Error('stylesheet targets classes the component never renders: ' + missing.join(', '));
}

const icon = (paths, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const MIC = '<rect x="9" y="2.6" width="6" height="10.6" rx="3"/><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0"/><path d="M12 18v3.4"/>';
const SPEAKER = '<path d="M4 9.6h3.1L12 5.6v12.8l-4.9-4H4z"/><path d="M15.4 9.6a3.6 3.6 0 0 1 0 4.8"/><path d="M18.3 7.1a7.4 7.4 0 0 1 0 9.8"/>';
const BOLT = '<path d="M13.3 2.4 5.6 13.3h4.9l-1.1 8.3 8.1-11.2h-5z"/>';
const GEAR = '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.3 2.7a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.3 2.7h4l.3-2.7c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4z"/><circle cx="12" cy="12" r="2.6"/>';

const bead = (label, paths, tx, ty, on, tone) =>
  `<div class="dshv-node" data-on="${on}" data-tone="${tone}" style="--tx:${tx}px;--ty:${ty}px">` +
  `<span class="dshv-cap">${label}</span>` +
  `<button class="dshv-bead" type="button">${icon(paths, 19)}</button></div>`;

// Mirrors the inline `styles` object plus the CSS classes client.js renders.
const panel = `
<div class="dshv-panel" data-wide="true" style="position:relative;z-index:60;width:340px;padding:14px;border-radius:22px;
  border:1px solid var(--dshv-glass-stroke);background:var(--dshv-glass);
  backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);
  box-shadow:var(--dshv-glass-shadow),inset 0 1px 0 var(--dshv-glass-inner);
  color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.6">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <h4 style="margin:0;font-size:13px;font-weight:600">DSH-Voice</h4>
    <i class="dshv-readydot" style="color:#10b981"></i>
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;
      color:var(--dsw-alias-label-secondary,inherit)">语音引擎就绪</span>
    <button style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;
      border:1px solid transparent;border-radius:10px;background:var(--dshv-field);color:inherit;font:inherit;cursor:pointer">✕</button>
  </div>

  <div style="margin-top:10px;padding-top:9px;border-top:1px solid var(--dshv-sep)">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;font-size:12.5px">音色</div>
    <div style="display:flex;gap:6px;margin:6px 0">
      <select style="flex:1;height:30px;padding:0 10px;border:1px solid transparent;border-radius:10px;background:var(--dshv-field);color:inherit;font:inherit;font-size:12px">
        <optgroup label="TTS 服务"><option>mimo_default</option><option>冰糖 · 中文女声</option></optgroup>
        <optgroup label="新建克隆音色"><option>🎤 009_起风的时候…（克隆）</option></optgroup>
      </select>
    </div>
    <div class="dshv-voicerow" style="display:flex;align-items:center;gap:6px;margin:5px 0">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">009_起风的时候…</span>
      <span style="color:var(--dsw-alias-label-tertiary,inherit);font-size:11px">65 KB</span>
      <audio controls style="height:26px;max-width:132px"></audio>
      <button style="display:inline-flex;align-items:center;height:26px;padding:0 9px;border-radius:10px;border:1px solid transparent;
        background:var(--dshv-field);color:inherit;font:inherit;font-size:12px;cursor:pointer">删除</button>
    </div>
  </div>

  <details style="margin-top:10px;padding-top:9px;border-top:1px solid var(--dshv-sep)" open>
    <summary style="cursor:pointer;font-size:12.5px;font-weight:600">新建克隆音色</summary>
    <div style="display:flex;gap:6px;margin:6px 0"><input placeholder="参考音频说了什么（可选）" style="width:100%;box-sizing:border-box;height:30px;padding:0 10px;border:1px solid transparent;border-radius:10px;background:var(--dshv-field);color:inherit;font:inherit;font-size:12px"></div>
    <div class="dshv-progress" style="margin-top:7px">
      <div class="dshv-progress-meta" style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)">
        <span>正在准备语音模型…</span><span>128.4 MB / 231.6 MB</span>
      </div>
      <div class="dshv-bar" data-busy="true" style="position:relative;height:5px;margin-top:5px;border-radius:3px;overflow:hidden;background:var(--dshv-field)">
        <i style="position:absolute;top:0;bottom:0;left:0;width:55%;border-radius:3px;background:var(--dshv-accent)"></i>
      </div>
    </div>
  </details>

  <details class="dshv-diag" style="margin-top:10px;padding-top:9px;border-top:1px solid var(--dshv-sep);margin-top:5px;color:var(--dsw-alias-label-secondary,inherit)" open>
    <summary style="cursor:pointer;font-size:11.5px">诊断</summary>
    <div class="dshv-kv" style="display:flex;align-items:baseline;gap:8px;margin:4px 0"><span style="flex:none;min-width:58px;color:var(--dsw-alias-label-secondary,inherit)">识别</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">sensevoice-small · int8</span></div>
    <div class="dshv-kv" style="display:flex;align-items:baseline;gap:8px;margin:4px 0"><span style="flex:none;min-width:58px;color:var(--dsw-alias-label-secondary,inherit)">断句 VAD</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">firered</span></div>
    <div class="dshv-diag-actions" style="display:flex;gap:10px;align-items:center;margin-top:6px">
      <button class="dshv-copy" type="button" style="border:0;background:none;padding:0;font:inherit;color:var(--dshv-accent);cursor:pointer">复制诊断信息</button>
    </div>
  </details>
</div>`;

const fanBeads = [
  bead('麦克风', MIC, -138, -8, '__MIC_ON__', '__MIC_TONE__'),
  bead('朗读', SPEAKER, -94, -46, 'false', 'none'),
  bead('插话', BOLT, -46, -68, 'false', 'none'),
  bead('设置', GEAR, 4, -72, 'false', 'none'),
].join('\n            ');

// Stuck to an edge the beads line up alongside it: a column for a vertical
// edge, a row for a horizontal one.
const columnBeads = [
  bead('麦克风', MIC, 0, -111, '__MIC_ON__', '__MIC_TONE__'),
  bead('朗读', SPEAKER, 0, -37, 'false', 'none'),
  bead('插话', BOLT, 0, 37, 'false', 'none'),
  bead('设置', GEAR, 0, 111, 'false', 'none'),
].join('\n            ');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>client.js 实际渲染的 C 方案</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#0f1115;background:#fff}
body[data-ds-dark-theme]{color:#f9fafb;background:#151517}
.wrap{display:flex;flex-direction:column;gap:26px;padding:20px}
.stage{position:relative;width:520px;min-height:760px;border-radius:20px;overflow:hidden;padding:14px;
  display:flex;flex-direction:column;gap:12px;border:1px solid rgba(120,120,128,.22);
  background:radial-gradient(90% 60% at 8% 4%,rgba(120,180,255,.30),transparent 60%),
    radial-gradient(80% 55% at 96% 90%,rgba(255,170,120,.26),transparent 62%),
    linear-gradient(160deg,#f7f8fb,#eef1f6)}
body[data-ds-dark-theme] .stage{border-color:rgba(255,255,255,.14);
  background:radial-gradient(90% 60% at 8% 4%,rgba(60,110,200,.34),transparent 60%),
    radial-gradient(80% 55% at 96% 90%,rgba(190,90,60,.26),transparent 62%),
    linear-gradient(160deg,#20222a,#141519)}
.bubble{max-width:78%;padding:8px 12px;border-radius:16px;font-size:12px}
.bubble.user{align-self:flex-end;background:rgba(120,120,128,.22)}
.bubble.bot{align-self:flex-start;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.7);color:#61666b}
body[data-ds-dark-theme] .bubble.bot{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.12);color:#cfd3d6}
.spacer{flex:1}
.anchor{position:relative;margin-left:auto;margin-right:8px;padding-top:190px}
.orbwrap{position:relative;width:52px;height:52px}
h2{font-size:13px;margin:0}
${css}
</style></head>
<body>
<div class="wrap">
  <h2>__CAPTION__</h2>
  <div class="stage">
    <div class="bubble user">把设置面板的字看清楚点</div>
    <div class="bubble bot">这一段用的是 client.js 里真正发出去的那段 CSS。</div>
    __SPACER__
    <div class="anchor">
      <div class="dshv" data-state="__STATE__" data-expanded="__OPEN__" data-attached="__ATTACH__">
        <div class="dshv-orbwrap">
          <span class="dshv-wave"></span>
          <span class="dshv-gel"><button class="dshv-orb" type="button">${icon(MIC)}</button></span>
          <div class="dshv-spread">
            __BEADS__
          </div>
        </div>
      </div>
    </div>
  </div>
  __PANEL__
</div>
<script>
var q = new URLSearchParams(location.search);
if (q.get('skin') === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
// Reproduce the rAF driver so the speaking silhouette can be seen deformed.
var orb = document.querySelector('.dshv-orb');
var root = document.querySelector('.dshv');
var WAVE = [
  { f: 0.27, phase: 0, v: false }, { f: 0.41, phase: 1.9, v: true },
  { f: 0.63, phase: 3.7, v: false }, { f: 0.19, phase: 5.1, v: true }
];
function waveRadius(t, amp) {
  var h = [], v = [];
  for (var i = 0; i < 4; i++) {
    var w = WAVE[i], s = Math.sin(2 * Math.PI * w.f * t + w.phase);
    var big = amp * 8.5 * s, small = amp * 2.5 * s;
    h.push((50 + (w.v ? small : big)).toFixed(2) + '%');
    v.push((50 + (w.v ? big : small)).toFixed(2) + '%');
  }
  return h.join(' ') + ' / ' + v.join(' ');
}
if (root.dataset.state === 'speaking') {
  var t0 = performance.now();
  (function step(now) {
    requestAnimationFrame(step);
    var level = Number(q.get('lvl') ?? 0.9);
    root.style.setProperty('--dshv-lvl', String(level));
    orb.style.borderRadius = waveRadius((now - t0) / 1000, level);
  })(t0);
}
</script>
</body></html>`;

const states = {
  idle: { state: 'idle', open: 'false', micOn: 'false', micTone: 'none' },
  listening: { state: 'listening', open: 'false', micOn: 'true', micTone: 'record' },
  recognizing: { state: 'recognizing', open: 'false', micOn: 'true', micTone: 'warn' },
  speaking: { state: 'speaking', open: 'false', micOn: 'false', micTone: 'none' },
  notready: { state: 'notready', open: 'false', micOn: 'false', micTone: 'none' },
  expanded: { state: 'listening', open: 'true', micOn: 'true', micTone: 'record' },
  'attached-left': { state: 'idle', open: 'false', micOn: 'false', micTone: 'none', attach: 'left' },
  'attached-right': { state: 'idle', open: 'false', micOn: 'false', micTone: 'none', attach: 'right' },
  'attached-top': { state: 'idle', open: 'false', micOn: 'false', micTone: 'none', attach: 'top' },
  'attached-bottom': { state: 'idle', open: 'false', micOn: 'false', micTone: 'none', attach: 'bottom' },
  'attached-expanded': {
    state: 'listening', open: 'true', micOn: 'true', micTone: 'record',
    attach: 'left', beads: 'column',
  },
};

for (const [name, spec] of Object.entries(states)) {
  const caption = {
    idle: '待机：透明胶球，图标为常规色',
    listening: '聆听：球体不变色，只有麦克风图标变红 + 水波纹 + 震动',
    recognizing: '识别中：图标变琥珀，水波更快',
    speaking: '朗读中：轮廓由音频驱动，不规则起伏',
    notready: '未就绪：图标变琥珀 + ⚠ 提示',
    expanded: '展开：大水珠碎成四颗小胶球，各带名称',
    'attached-left': '吸在左边缘：球体被压扁、向下耷拉（瘫软形态）',
    'attached-right': '吸在右边缘：镜像的瘫软形态',
    'attached-top': '吸在上边缘：竖向压扁、向下坠',
    'attached-bottom': '吸在下边缘：竖向压扁、往上贴',
    'attached-expanded': '吸边状态展开：四颗小胶球沿边缘**平行排成一列**',
  }[name];
  const file = path.join(here, 'orb-live-' + name + '.html');
  fs.writeFileSync(file, html
    .replace('__CAPTION__', caption)
    .replace('__PANEL__', spec.attach ? '' : panel)
    .replace('__BEADS__', spec.beads === 'column' ? columnBeads : fanBeads)
    .replace('__SPACER__', spec.attach ? '' : '<div class="spacer"></div>')
    .replace('__ATTACH__', spec.attach ?? 'none')
    .replace('__STATE__', spec.state)
    .replace('__OPEN__', spec.open)
    .replace('__MIC_ON__', spec.micOn)
    .replace('__MIC_TONE__', spec.micTone));
  console.log('wrote ' + path.basename(file));
}
console.log('classes checked: ' + classes.length + ' (' + classes.join(', ') + ')');
