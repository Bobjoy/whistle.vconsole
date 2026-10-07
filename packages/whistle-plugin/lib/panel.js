/**
 * The device panel + per-session debugging drawer, served on :9527.
 *
 * Left: session list (from list_sessions, in connection order). Click a
 * session → a right-side drawer with vConsole-style tabs: System / Logs /
 * Network / Element / Vue / Storage / Screenshot. The JS console input lives
 * at the bottom of the Logs tab. Everything runs through the same tool
 * backend the MCP clients use, targeted at the selected session.
 *
 * Element and Vue are eval-driven: the tabs ship self-contained serializers
 * that run on the page through eval_js (elementSnippet / vueSnippet below),
 * so they work against every published probe with zero protocol changes.
 * Vue walks __vue_app__ (set unconditionally on mount containers even in
 * production builds; the devtools hook is dev-only). The on-page
 * vConsole element UI is NOT embedded — it is hard-wired to its in-page
 * svelte stores, and a remote renderer only needs the tool API. (chii made
 * the same call for eruda.)
 */

/**
 * Session-card text split — the same source the panel runs (it is injected into
 * the page below via .toString(), and http.e2e tests this function directly).
 *
 * `deviceName` and the parenthesised product in `deviceLabel` usually say the
 * same thing twice, so the card would show the browser name twice. Keep the name
 * in the muted slot and move over only the version number the parenthetical
 * carries: ("Chrome 146（App ZCode 3.14.4）", "我的电脑")
 * → label "Chrome 146", muted "我的电脑 3.14.4".
 */
function splitCardText(label, deviceName) {
  if (!deviceName || label.indexOf(deviceName) === 0) { return { label, muted: '' }; }
  const open = label.lastIndexOf('（');
  if (open > 0 && label.charAt(label.length - 1) === '）') {
    const bits = label.slice(open + 1, label.length - 1).split(' ');
    const last = bits[bits.length - 1] || '';
    const ver = last.charAt(0) >= '0' && last.charAt(0) <= '9' ? last : '';
    return { label: label.slice(0, open), muted: deviceName + (ver ? ' ' + ver : '') };
  }
  return { label, muted: deviceName };
}

module.exports = function buildPanelHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>设备列表</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 0; background: #f5f6f8; color: #1d2129; display: flex; height: 100vh; overflow: hidden; }
  #list { width: 420px; min-width: 320px; border-right: 1px solid #e5e6eb; display: flex; flex-direction: column; background: #fff; }
  #list header { padding: 12px 16px; border-bottom: 1px solid #e5e6eb; display: flex; align-items: center; gap: 8px; position: relative; }
  #list header h1 { font-size: 15px; margin: 0; }
  #hub { font-size: 12px; padding: 2px 10px; border-radius: 10px; background: #f2f3f5; }
  #hub.ok { background: #e8ffea; color: #00b42a; }
  #hub.bad { background: #ffece8; color: #f53f3f; }
  #mcp-help { margin-left: auto; font-size: 12px; }
  #mcp-help summary { cursor: pointer; color: #4e5969; list-style: none; }
  #mcp-help summary:hover { color: #165dff; }
  #mcp-help pre { position: absolute; left: 12px; right: 12px; top: calc(100% + 2px); z-index: 20; max-height: calc(100vh - 70px); overflow: auto; margin: 0; background: #fff; border: 1px solid #e5e6eb; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.08); color: #1d2129; text-align: left; white-space: pre-wrap; }
  #sessions { flex: 1; overflow: auto; padding: 8px; }
  .card { border: 1px solid #e5e6eb; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
  .card:hover { border-color: #94bfff; background: #f7f9ff; }
  .card.sel { border-color: #165dff; background: #f0f5ff; }
  .card .row1 { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .card .dev { font-weight: 600; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .dot.on { background: #00b42a; }
  .dot.off { background: #c9cdd4; }
  .card .row2 { font-size: 12px; color: #4e5969; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .row3 { font-size: 12px; color: #86909c; margin-top: 2px; }
  .st-on { color: #00b42a; }
  .st-off { color: #f53f3f; }
  .empty { padding: 40px 20px; text-align: center; color: #86909c; font-size: 13px; }

  #drawer { flex: 1; display: none; flex-direction: column; background: #fff; }
  #drawer.open { display: flex; }
  #drawer .head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #e5e6eb; }
  #drawer .head .sid { font-size: 13px; font-weight: 600; }
  #drawer .head .close { margin-left: auto; cursor: pointer; border: 1px solid #e5e6eb; border-radius: 6px; padding: 3px 10px; font-size: 12px; background: #fff; }
  .tabs { display: flex; gap: 2px; padding: 6px 10px; border-bottom: 1px solid #e5e6eb; background: #fafbfc; }
  .tabs button { border: none; background: transparent; padding: 6px 14px; font-size: 13px; border-radius: 6px; cursor: pointer; color: #4e5969; }
  .tabs button.on { background: #165dff; color: #fff; }
  .pane { flex: 1; overflow: auto; display: none; padding: 12px 14px; }
  .pane.on { display: block; }
  /* the logs pane owns its own scroll area so the JS console below never moves */
  #pane-logs.on { display: flex; flex-direction: column; overflow: hidden; }
  #logs-body { flex: 1; overflow: auto; min-height: 0; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f2f3f5; vertical-align: top; }
  th { color: #86909c; font-weight: 500; background: #fafbfc; }
  pre { background: #f7f8fa; padding: 8px 10px; border-radius: 6px; overflow: auto; max-width: 100%; font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 4px 0; }
  .lv-log { color: #1d2129; } .lv-info { color: #165dff; } .lv-warn { color: #ff7d00; } .lv-error { color: #f53f3f; } .lv-debug { color: #86909c; }
  .logline { padding: 4px 6px; border-bottom: 1px solid #f7f8fa; font-size: 12px; font-family: ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .logmeta { color: #86909c; margin-right: 8px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .toolbar select, .toolbar input { font-size: 12px; padding: 4px 8px; border: 1px solid #e5e6eb; border-radius: 6px; }
  .toolbar button, #console button, #sto-body button, #net-body button { font-size: 12px; padding: 4px 12px; border: 1px solid #e5e6eb; border-radius: 6px; background: #fff; cursor: pointer; white-space: nowrap; flex: none; }
  .toolbar button:hover, #console button:hover, #sto-body button:hover, #net-body button:hover { border-color: #165dff; color: #165dff; }
  #sto-body input, #sto-body textarea { width: 100%; font-size: 12px; font-family: ui-monospace, Menlo, monospace; padding: 4px 8px; border: 1px solid #165dff; border-radius: 6px; }
  #sto-body textarea { resize: vertical; min-height: 56px; line-height: 1.5; }
  .sto-acts { display: flex; gap: 6px; flex-wrap: nowrap; }
  #console input { flex: 1; font-family: ui-monospace, Menlo, monospace; font-size: 12px; padding: 6px 10px; border: 1px solid #e5e6eb; border-radius: 6px; }
  #console { flex: none; border-top: 1px solid #f2f3f5; margin-top: 12px; padding-top: 12px; }
  #console .in { display: flex; gap: 8px; margin-bottom: 10px; }
  .kv { font-size: 12px; }
  .kv b { display: inline-block; min-width: 140px; }
  img.shot { max-width: 100%; border: 1px solid #e5e6eb; border-radius: 8px; }
  .muted { color: #86909c; }
  .spin { color: #86909c; font-size: 12px; }

  /* copy buttons: inline mini buttons wherever copyable content lives */
  button.cpy { font-size: 11px; padding: 1px 8px; border: 1px solid #e5e6eb; border-radius: 6px; background: #fff; color: #4e5969; cursor: pointer; flex: none; }
  button.cpy:hover { border-color: #165dff; color: #165dff; }
  .card .row1 .cpy { margin-left: auto; }
  details.hsec > summary .cpy { margin-left: auto; }
  #mcp-help .cpy { margin-left: 8px; }

  /* DevTools-style detail sections: collapsible header + 原始 toggle + name/value table */
  details.hsec { border: 1px solid #e5e6eb; border-radius: 6px; margin: 8px 0; overflow: hidden; }
  details.hsec > summary { list-style: none; cursor: pointer; padding: 6px 10px; background: #fafbfc; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; user-select: none; }
  details.hsec > summary::-webkit-details-marker { display: none; }
  details.hsec > summary::before { content: '▸'; color: #86909c; font-size: 10px; }
  details.hsec[open] > summary::before { content: '▾'; }
  table.headers { width: 100%; border-collapse: collapse; font-size: 12px; font-family: ui-monospace, Menlo, monospace; }
  table.headers th, table.headers td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f2f3f5; vertical-align: top; background: #fff; word-break: break-all; }
  table.headers th { width: 30%; font-weight: 400; }
  table.headers td.k { width: 30%; }
  table.headers td.ops { width: 110px; text-align: right; white-space: nowrap; }
  table.headers tr:hover th, table.headers tr:hover td { background: #f7f8fa; }
  /* storage rows: taller than text because of the buttons — center everything */
  #sto-body td { vertical-align: middle; }
  details.hsec > pre.raw { margin: 0; border-radius: 0; border: none; }
  /* long URLs wrap normally inside the URL column instead of spilling over */
  #net-body td.url { word-break: break-all; }
  #net-body tbody tr:not(.drow):hover td { background: #f7f9ff; }
  #net-body tr.exp td { background: #f0f5ff; }
  #net-body tr.drow td { background: #fcfdff; padding: 4px 8px 10px; }
  #net-body .dbody { padding: 0 2px; }
  #net-body .dbody details.hsec:first-child { margin-top: 0; }
  #net-detail h4 { word-break: break-all; }

  /* element tree (eval-driven, see elementSnippet) */
  #pane-element.on { display: flex; flex-direction: column; overflow: hidden; }
  #elem-body { flex: 1; overflow: auto; min-height: 0; }
  #elem-detail { display: none; flex: none; max-height: 45%; overflow: auto; border-top: 1px solid #e5e6eb; padding-top: 8px; }
  #elem-detail.on { display: block; }
  .elem-row { display: flex; align-items: baseline; gap: 4px; padding: 2px 6px; font-size: 12px; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; cursor: pointer; border-radius: 4px; }
  .elem-row:hover { background: #f7f9ff; }
  .elem-row.sel { background: #f0f5ff; }
  .elem-tg { flex: none; width: 12px; color: #86909c; cursor: pointer; }
  .elem-tag { color: #165dff; }
  .elem-x { color: #86909c; overflow: hidden; text-overflow: ellipsis; }

  /* vue tab reuses the elem-* tree rows; only the pane layout is its own */
  #pane-vue.on { display: flex; flex-direction: column; overflow: hidden; }
  #vue-body { flex: 1; overflow: auto; min-height: 0; }
  #vue-detail { display: none; flex: none; max-height: 45%; overflow: auto; border-top: 1px solid #e5e6eb; padding-top: 8px; }
  #vue-detail.on { display: block; }
</style>
</head>
<body>
  <div id="list">
    <header>
      <h1>设备列表</h1>
      <span id="hub">connecting…</span>
      <details id="mcp-help">
        <summary>MCP配置<button class="cpy" onclick="copyMcp(this)">复制</button></summary>
        <pre id="mcp-conf"></pre>
      </details>
    </header>
    <div id="sessions" class="empty">loading…</div>
  </div>
  <div id="drawer">
    <div class="head">
      <span class="sid" id="d-sid"></span>
      <span class="muted" id="d-dev" style="font-size:12px"></span>
      <button class="close" onclick="closeDrawer()">关闭 ✕</button>
    </div>
    <div class="tabs">
      <button data-t="info" class="on">System</button>
      <button data-t="logs">Logs</button>
      <button data-t="network">Network</button>
      <button data-t="element">Element</button>
      <button data-t="vue">Vue</button>
      <button data-t="storage">Storage</button>
      <button data-t="screenshot">Screenshot</button>
    </div>
    <div class="pane on" id="pane-info">
      <div class="toolbar"><button onclick="loadInfo()">刷新</button><button onclick="copyInfo(this)">复制</button></div>
      <div id="info-body"></div>
    </div>
    <div class="pane" id="pane-logs">
      <div class="toolbar">
        <select id="log-level"><option value="">all levels</option><option>log</option><option>info</option><option>warn</option><option>error</option><option>debug</option></select>
        <input id="log-kw" placeholder="keyword…" style="width:160px">
        <button onclick="copyLogs(this)">复制</button>
      </div>
      <div id="logs-body"></div>
      <div id="console">
        <div class="in">
          <input id="eval-expr" placeholder="JavaScript expression, 回车执行（如 document.title）" onkeydown="if(event.key==='Enter')runEval()">
          <button onclick="runEval()">Run</button>
        </div>
        <div id="eval-out" class="muted" style="font-size:12px">在页面全局上下文执行 JS；结果同时出现在页面的 vConsole 面板。</div>
      </div>
    </div>
    <div class="pane" id="pane-network">
      <div class="toolbar">
        <input id="net-filter" placeholder="url filter…" style="width:220px" oninput="netFilterChanged()">
        <select id="net-type" onchange="loadNetwork()">
          <option value="">全部类型</option>
          <option value="css">css</option>
          <option value="js">js</option>
          <option value="img">img</option>
          <option value="xhr">xhr</option>
          <option value="ws">ws</option>
          <option value="other">other</option>
        </select>
        <span class="spin" id="net-spin"></span>
      </div>
      <div id="net-body"></div>
    </div>
    <div class="pane" id="pane-element">
      <div class="toolbar"><button onclick="loadElementRoot()">刷新</button><span class="muted" style="font-size:12px">点箭头展开、点行看 outerHTML；数据由 eval_js 在页面上实时采集</span><span class="lv-error" id="elem-msg"></span><span class="spin" id="elem-spin"></span></div>
      <div id="elem-body"></div>
      <div id="elem-detail">
        <div class="toolbar"><b style="font-size:12px" id="elem-detail-title"></b><button class="cpy" onclick="copyElemHtml(this)">复制</button><button onclick="closeElemDetail()">关闭</button></div>
        <pre class="raw" id="elem-detail-pre"></pre>
      </div>
    </div>
    <div class="pane" id="pane-vue">
      <div class="toolbar"><button onclick="loadVueRoot()">刷新</button><span class="muted" style="font-size:12px">Vue 3 组件树与状态（eval_js 实时采集，生产页面可用）</span><span class="lv-error" id="vue-msg"></span><span class="spin" id="vue-spin"></span></div>
      <div id="vue-body"></div>
      <div id="vue-detail">
        <div class="toolbar"><b style="font-size:12px" id="vue-detail-title"></b><button class="cpy" onclick="copyVueState(this)">复制</button><button onclick="closeVueDetail()">关闭</button></div>
        <pre class="raw" id="vue-detail-pre"></pre>
      </div>
    </div>
    <div class="pane" id="pane-storage">
      <div class="toolbar"><button onclick="loadStorage()">刷新</button><span class="spin" id="sto-spin"></span><span id="sto-msg" class="muted" style="font-size:12px"></span></div>
      <div id="sto-body"></div>
    </div>
    <div class="pane" id="pane-screenshot">
      <div class="toolbar"><button onclick="loadShot()">截图（html2canvas）</button><span class="spin" id="shot-spin"></span></div>
      <div id="shot-body" class="muted" style="font-size:12px">canvas/WebGL 内容与部分 CSS 效果可能缺失；首次截图时探针会在页面内加载 html2canvas（优先本地 hub，CDN 兜底）。</div>
    </div>
  </div>
<script>
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  let current = null;
  let lastLogs = null;
  let lastLogItems = [];
  let lastNet = null;
  let lastCards = '';
  const netCache = {};
  // injected from the Node-side definition above so panel and unit test share one implementation
  const splitCardText = ${splitCardText.toString()};
  // a panel opened from another machine must carry the hub token it was handed
  // in its own URL; on the dev machine (loopback) there is nothing to carry
  const T = new URLSearchParams(location.search).get('t') || '';
  const TQ = T ? '?t=' + encodeURIComponent(T) : '';

  const MCP_CONF = JSON.stringify({
    mcpServers: { vconsole: { type: 'http', url: 'http://' + location.host + '/mcp' + TQ } },
  }, null, 2);

  function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    clearTimeout(btn._cpyT);
    btn._cpyT = setTimeout(() => { btn.textContent = old; }, 1200);
  }

  // The panel is routinely opened over LAN http, where the async clipboard API
  // does not exist (secure-context only) — fall back to the hidden-textarea +
  // execCommand dance, which still works in plain http. btn gets "已复制" feedback.
  async function copyText(text, btn) {
    text = String(text == null ? '' : text);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    if (btn) { flashBtn(btn, ok ? '已复制' : '复制失败'); }
    return ok;
  }

  function copyMcp(btn) { copyText(MCP_CONF, btn); }

  // lives on the session card; stopPropagation keeps the drawer from opening
  function copyCardUrl(btn, ev) {
    ev.stopPropagation();
    copyText(btn.dataset.url, btn);
  }

  async function api(name, args, sessionId) {
    const r = await fetch('/api/tool' + TQ, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: args || {}, sessionId }) });
    const result = await r.json();
    if (result.isError) { throw new Error((result.content[0] || {}).text || 'tool error'); }
    const text = (result.content[0] || {}).text;
    if (typeof text === 'string' && text.indexOf('[truncated by whistle-vconsole]') > -1) {
      throw new Error('结果过大被截断，请缩小 limit 或加筛选条件');
    }
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  // list_sessions answers { sessions: [...] } — an array means the hub is reachable
  function hubBadge(d) {
    const el = document.getElementById('hub');
    if (Array.isArray(d.sessions)) { el.textContent = 'running'; el.className = 'ok'; }
    else { el.textContent = 'stopped'; el.className = 'bad'; }
  }

  // pre = snapshot pushed over SSE; omit to fetch /api/sessions yourself
  async function renderSessions(pre) {
    try {
      const d = pre || await fetch('/api/sessions').then((r) => r.json());
      const ready = Array.isArray(d.sessions);
      hubBadge(d);
      const box = document.getElementById('sessions');
      if (!ready || !d.sessions.length) {
        box.className = 'empty';
        box.textContent = ready ? '暂无设备连接 — 手机打开接了探针的 H5 页面即可' : ('无法连接 hub：' + (d.error || d.status || 'bad response'));
        lastCards = '';
        return;
      }
      box.className = '';
      const cards = d.sessions.map((s) => {
        const text = splitCardText(s.deviceLabel || s.sessionId, s.deviceName);
        const label = text.label;
        const muted = text.muted ? '<span class="muted">(' + esc(text.muted) + ')</span>' : '';
        // protocol drift is a warning, never a block (ADR-008): say which number
        // the page reported so the operator can tell old page from new hub
        const proto = s.protocolMismatch === undefined ? ''
          : '<span class="muted">(协议 ' + esc(String(s.protocolMismatch)) + ' 与本端不符)</span>';
        return '<div class="card' + (current === s.sessionId ? ' sel' : '') + '" onclick="openSession(\\'' + s.sessionId + '\\')">' +
        '<div class="row1"><span class="dot ' + (s.online ? 'on' : 'off') + '"></span>' +
        '<span class="dev">' + esc(label) + '</span>' +
        muted +
        proto +
        (s.url ? '<button class="cpy" data-url="' + esc(s.url) + '" onclick="copyCardUrl(this, event)">复制URL</button>' : '') +
        '</div>' +
        '<div class="row2" title="' + esc(s.url) + '">' + esc(s.title || '') + ' — ' + esc(s.url || '') + '</div>' +
        '<div class="row3">' + esc(s.viewport ? s.viewport.width + '×' + s.viewport.height + ' @' + s.viewport.dpr : '') +
        ' · ' + s.logCount + ' logs · ' + s.networkCount + ' reqs · ' +
        '<span class="' + (s.online ? 'st-on' : 'st-off') + '">' + (s.online ? 'online' : 'offline') + '</span></div></div>';
      }).join('');
      // re-rendering on every poll detaches the node under the cursor and swallows clicks
      if (cards !== lastCards) { lastCards = cards; box.innerHTML = cards; }
    } catch (e) {
      document.getElementById('hub').textContent = 'stopped';
      document.getElementById('hub').className = 'bad';
    }
  }

  function openSession(id) {
    current = id;
    lastLogs = null;
    lastNet = null;
    openDetailId = null;
    detailHtml = null;
    elemNodes = {};
    elemSelected = null;
    vueNodes = {};
    vueApps = null;
    vueSelected = null;
    renderSessions();
    document.getElementById('drawer').classList.add('open');
    document.getElementById('d-sid').textContent = id;
    selectTab('info');
    loadLogs(); loadNetwork(); loadStorage(); loadInfo();
    document.getElementById('shot-body').innerHTML = '<span class="muted">点击"截图"按钮生成</span>';
    document.getElementById('elem-body').innerHTML = '<span class="muted">打开 Element 标签后从页面采集 DOM</span>';
    document.getElementById('elem-detail').classList.remove('on');
    document.getElementById('vue-body').innerHTML = '<span class="muted">打开 Vue 标签后从页面采集组件树</span>';
    document.getElementById('vue-detail').classList.remove('on');
    document.getElementById('eval-out').innerHTML = '<span class="muted">在页面全局上下文执行 JS；结果同时出现在页面的 vConsole 面板。</span>';
  }
  function closeDrawer() { current = null; document.getElementById('drawer').classList.remove('open'); renderSessions(); }

  function selectTab(t) {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
    document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('on', x.id === 'pane-' + t));
  }

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      selectTab(b.dataset.t);
      // network updates arrive only while its pane is visible; a fresh load on
      // switch keeps it from showing stale data. Same for storage/system: their
      // data is command-on-demand, so re-fetch when entering the tab.
      if (b.dataset.t === 'network') { loadNetwork(); }
      if (b.dataset.t === 'element') { ensureElement(); }
      if (b.dataset.t === 'vue') { ensureVue(); }
      if (b.dataset.t === 'storage') { loadStorage(); }
      if (b.dataset.t === 'info') { loadInfo(); }
    };
  });

  async function loadLogs() {
    if (!current) { return; }
    const box = document.getElementById('logs-body');
    try {
      const d = await api('get_logs', { level: document.getElementById('log-level').value || undefined,
        keyword: document.getElementById('log-kw').value || undefined, limit: 200 }, current);
      lastLogItems = d.items || [];
      const html = d.items.map((it) =>
        '<div class="logline"><span class="logmeta">' + new Date(it.date).toLocaleTimeString() + ' <b class="lv-' + it.type + '">' + it.type + '</b>' +
        (it.repeated ? ' ×' + (it.repeated + 1) : '') + '</span>' + esc(it.args.join(' ')) + '</div>'
      ).join('') || '<span class="muted">no logs</span>';
      // repaint only on change: rewriting every poll collapses the scroll height, which
      // bounced the docked console below up and down
      if (html !== lastLogs) {
        const atBottom = box.scrollHeight - box.clientHeight - box.scrollTop < 24;
        const top = box.scrollTop;
        lastLogs = html;
        box.innerHTML = html;
        box.scrollTop = atBottom ? box.scrollHeight : top;
      }
    } catch (e) {
      lastLogs = null;
      lastLogItems = [];
      box.innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
  }

  // copies exactly what the filtered view shows, in a paste-friendly text form;
  // a repeated log is expanded to its real count (the ×n on screen means n+1)
  function formatLogs(items) {
    return items.map((it) =>
      '[' + new Date(it.date).toLocaleTimeString() + '] [' + it.type + '] ' +
      it.args.join(' ') + (it.repeated ? ' (×' + (it.repeated + 1) + ')' : '')
    ).join('\\n');
  }

  function copyLogs(btn) {
    if (!lastLogItems.length) { flashBtn(btn, '无日志'); return; }
    copyText(formatLogs(lastLogItems), btn);
  }

  let netFilterTimer = null;
  function netFilterChanged() {
    clearTimeout(netFilterTimer);
    netFilterTimer = setTimeout(loadNetwork, 300);
  }

  async function loadNetwork() {
    if (!current) { return; }
    document.getElementById('net-spin').textContent = '…';
    try {
      const d = await api('get_network', {
        urlFilter: document.getElementById('net-filter').value || undefined,
        type: document.getElementById('net-type').value || undefined,
        limit: 100,
      }, current);
      if (!d || !Array.isArray(d.items)) { throw new Error('返回的不是列表：' + esc(String(d).slice(0, 120))); }
      netCache.list = d.items;
      const html = buildNetHtml();
      // same repaint guard as logs: SSE pushes must not clobber an open detail
      // view (or reset scroll) when the visible list did not actually change
      if (html !== lastNet) {
        lastNet = html;
        document.getElementById('net-body').innerHTML = html;
      }
    } catch (e) {
      document.getElementById('net-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
    document.getElementById('net-spin').textContent = '';
  }

  let openDetailId = null;
  let openDetailData = null;
  let detailHtml = null;
  let replayState = { forId: '', text: '', body: null };

  function buildNetHtml() {
    const items = netCache.list || [];
    let detailUsed = false;
    const rows = items.length === 0
      ? '<tr><td colspan="5" class="muted">没有匹配的请求</td></tr>'
      : items.map((r, i) => {
          let detail = '';
          if (openDetailId && r.id === openDetailId) {
            detailUsed = true;
            detail = '<tr class="drow"><td colspan="5"><div class="dbody" id="net-detail">' + (detailHtml || '') + '</div></td></tr>';
          }
          return '<tr onclick="toggleNet(' + i + ')"' + (openDetailId === r.id ? ' class="exp"' : '') + ' style="cursor:pointer">' +
            '<td>' + esc(r.method) + '</td><td class="url" title="' + esc(r.url) + '">' + esc(r.url) + '</td>' +
            '<td>' + esc(r.status) + '</td><td>' + esc(r.costTime) + 'ms</td><td class="muted">' + esc(r.requestType) + '</td></tr>' + detail;
        }).join('');
    if (openDetailId && !detailUsed) { openDetailId = null; openDetailData = null; detailHtml = null; } // item evicted
    return '<table><thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Time</th><th>Type</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function repaintNet() {
    const html = buildNetHtml();
    if (html !== lastNet) {
      lastNet = html;
      document.getElementById('net-body').innerHTML = html;
    }
  }

  // click a row → expand its detail inline beneath it (query params / headers /
  // body / replay); click again to collapse. Detail content is cached in detailHtml so
  // SSE-triggered repaints keep the pane open without refetching.
  async function toggleNet(i) {
    const item = (netCache.list || [])[i];
    if (!item) { return; }
    if (openDetailId === item.id) {
      openDetailId = null;
      openDetailData = null;
      detailHtml = null;
      repaintNet();
      return;
    }
    openDetailId = item.id;
    openDetailData = null;
    detailHtml = '<span class="muted">loading…</span>';
    repaintNet();
    try {
      openDetailData = await api('get_network', { requestId: item.id }, current);
      detailHtml = detailBody();
    } catch (e) {
      detailHtml = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
    paintDetail();
  }

  function paintDetail() {
    const el = document.getElementById('net-detail');
    if (el) { el.innerHTML = detailHtml; } else { repaintNet(); }
  }

  function detailBody() {
    const d = openDetailData;
    if (!d) { return ''; }
    return '<p style="margin:0 0 8px" class="muted">' + esc(d.requestType || '') +
        (d.replayedFrom ? ' · 重放自 ' + esc(d.replayedFrom) : '') +
        '<span style="float:right"><button class="cpy" onclick="copyNetUrl(this)">复制URL</button> ' +
        '<button class="cpy" onclick="copyCurl(this)">复制为cURL</button></span></p>' +
      querySection(d.url) +
      headerSection('请求标头', d.requestHeader, 'requestHeader') +
      headerSection('响应标头', d.responseHeader, 'responseHeader') +
      payloadSection('请求载荷', d.postData, 'postData') +
      payloadSection('响应内容', d.response, 'response') +
      replaySection(d) +
      (!d.requestHeader && !d.responseHeader && !d.postData && !d.response ? '<span class="muted">该请求无详细数据（resource 类捕获只有 URL/时序）</span>' : '');
  }

  const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS'];

  function replaySection(d) {
    if (d.requestType !== 'xhr' && d.requestType !== 'fetch') { return ''; }
    const method = String(d.method || 'GET').toUpperCase();
    const askFirst = IDEMPOTENT_METHODS.indexOf(method) > -1 ? 'false' : 'true';
    const done = replayState.forId === d.id;
    return '<details class="hsec" open><summary>重放</summary>' +
      '<div style="padding:8px 10px;font-size:12px">' +
        '<button onclick="replayReq(\\'' + d.id + '\\',\\'' + method + '\\',' + askFirst + ')">原样再发一次</button> ' +
        (done ? replayState.text : '<span class="muted">由页面自己发出，cookie 会自动带上；返回的是这次的响应</span>') +
      '</div>' +
      (done && replayState.body != null ? '<pre class="raw">' + esc(replayState.body) + '</pre>' : '') +
      '</details>';
  }

  async function replayReq(requestId, method, askFirst) {
    if (askFirst && !window.confirm(method + ' 不是幂等方法：重放会让服务端再做一次这件事。确定发送？')) { return; }
    replayState = { forId: requestId, text: '<span class="muted">发送中…</span>', body: null };
    detailHtml = detailBody();
    paintDetail();
    try {
      // the confirm above is the human half of the non-idempotent gate,
      // so the hub-side gate is told it is authorised
      const r = await api('replay_request', { requestId: requestId, allowUnsafe: true }, current);
      replayState = {
        forId: requestId,
        text: '<b>' + esc(r.status) + ' ' + esc(r.statusText) + '</b> · ' + esc(r.costTime) + 'ms · ' +
          esc(r.responseSize) + ' 字节' +
          (r.truncated ? '<span class="muted">（这里只显示前 8KB，完整内容看列表里新出现的那条）</span>' : ''),
        body: r.body,
      };
      loadNetwork();
    } catch (e) {
      replayState = { forId: requestId, text: '<span class="lv-error">' + esc(e.message) + '</span>', body: null };
    }
    if (openDetailId === requestId) {
      detailHtml = detailBody();
      paintDetail();
    }
  }

  function querySection(url) {
    try {
      const pairs = [];
      new URL(url, location.origin).searchParams.forEach((v, k) => pairs.push([k, v]));
      if (!pairs.length) { return ''; }
      return '<details class="hsec" open><summary>查询参数</summary><div class="tbl"><table class="headers"><tbody>' +
        pairs.map((kv) => '<tr><th>' + esc(kv[0]) + '</th><td>' + esc(decodeURIComponentSafe(kv[1])) + '</td></tr>').join('') +
        '</tbody></table></div></details>';
    } catch (e) { return ''; }
  }

  function decodeURIComponentSafe(v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  }
  // --- network detail: DevTools-style sections -----------------------------
  // serializeOne on the probe renders HeadersInit either as {k: v, ...} or
  // [[k, v], ...]; raw strings may already be "Name: value" lines. All three
  // parse into [name, value] pairs for the table view.
  function splitTopLevel(s, sep) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '{' || ch === '[' || ch === '(') { depth++; }
      else if (ch === '}' || ch === ']' || ch === ')') { depth--; }
      if (ch === sep && depth === 0) { parts.push(cur); cur = ''; }
      else { cur += ch; }
    }
    if (cur) { parts.push(cur); }
    return parts;
  }

  function parseHeaders(text) {
    if (!text) { return []; }
    const t = String(text).trim();
    const pairs = [];
    if (t[0] === '[') {
      for (const p of splitTopLevel(t.slice(1, -1), ',')) {
        const item = p.trim();
        if (!item.startsWith('[')) { continue; }
        const kv = splitTopLevel(item.slice(1, -1), ',');
        if (kv.length >= 2) {
          const k = kv[0].trim().replace(/^"|"$/g, '');
          pairs.push([k, kv.slice(1).join(', ').trim()]);
        }
      }
      if (pairs.length) { return pairs; }
    }
    if (t[0] === '{') {
      // values may contain commas (Date, Cache-Control, ...) — fragments
      // without ": " belong to the previous pair's value
      let last = null;
      for (const p of splitTopLevel(t.slice(1, -1), ',')) {
        const idx = p.indexOf(': ');
        if (idx > 0) {
          if (last) { pairs.push(last); }
          last = [p.slice(0, idx).trim(), p.slice(idx + 2).trim()];
        } else if (last && p.trim()) {
          last[1] += ', ' + p.trim();
        }
      }
      if (last) { pairs.push(last); }
      if (pairs.length) { return pairs; }
    }
    for (const line of t.split(/\\r?\\n/)) {
      const idx = line.indexOf(': ');
      if (idx > 0) { pairs.push([line.slice(0, idx).trim(), line.slice(idx + 2).trim()]); }
    }
    return pairs;
  }

  function headerSection(title, text, field) {
    if (text == null || text === '') { return ''; }
    const cpy = '<button class="cpy" onclick="copyDetailField(\\'' + field + '\\',this);event.preventDefault()">复制</button>';
    const pairs = parseHeaders(text);
    if (!pairs.length) {
      return '<details class="hsec" open><summary>' + title + cpy + '</summary>' +
        '<pre class="raw">' + esc(String(text)) + '</pre></details>';
    }
    const tbl = '<div class="tbl"><table class="headers"><tbody>' +
      pairs.map((kv) => '<tr><th>' + esc(kv[0]) + '</th><td>' + esc(kv[1]) + '</td></tr>').join('') +
      '</tbody></table></div>';
    return '<details class="hsec" open><summary>' + title + cpy + '</summary>' + tbl + '</details>';
  }

  function payloadSection(title, text, field) {
    if (text == null || text === '') { return ''; }
    return '<details class="hsec" open><summary>' + title +
      '<button class="cpy" onclick="copyDetailField(\\'' + field + '\\',this);event.preventDefault()">复制</button></summary>' +
      '<pre class="raw">' + esc(String(text)) + '</pre></details>';
  }

  // --- copy affordances in the network detail ------------------------------

  function copyNetUrl(btn) {
    if (openDetailData) { copyText(openDetailData.url, btn); }
  }

  function copyDetailField(field, btn) {
    if (openDetailData) { copyText(openDetailData[field], btn); }
  }

  function copyCurl(btn) {
    if (openDetailData) { copyText(buildCurl(openDetailData), btn); }
  }

  // POSIX single-quote quoting via split/join, so no escape gymnastics are
  // needed inside the page template
  function shellQuote(s) {
    const q = String.fromCharCode(39);
    const bs = String.fromCharCode(92);
    return q + String(s == null ? '' : s).split(q).join(q + bs + q + q) + q;
  }

  // DevTools-style "copy as cURL": captured headers are what the page actually
  // passed, body goes as text (the capture only keeps string bodies anyway)
  function buildCurl(d) {
    const cont = ' ' + String.fromCharCode(92) + String.fromCharCode(10) + '  ';
    const lines = ['curl ' + shellQuote(d.url)];
    const method = String(d.method || 'GET').toUpperCase();
    if (IDEMPOTENT_METHODS.indexOf(method) < 0) { lines.push('-X ' + method); }
    for (const kv of parseHeaders(d.requestHeader)) { lines.push('-H ' + shellQuote(kv[0] + ': ' + kv[1])); }
    if (d.postData != null && d.postData !== '') { lines.push('--data-raw ' + shellQuote(String(d.postData))); }
    return lines.join(cont);
  }

  // --- element tab (eval-driven DOM tree) ----------------------------------
  // The serializer ships to the page through eval_js (elementSnippet below),
  // so the tree works against every published probe with no protocol change.
  // Responses are display-strings and serializeOne truncates eval results at
  // 2000 chars — the snippet paginates the tree and chunks outerHTML to stay
  // under that; the panel loops until a response reports no next page.
  let elemNodes = {};
  let elemSelected = null;
  let elemDetailText = '';

  function elementSnippet(op, arg) {
    var W = window;
    if (!W.__vcElem) {
      W.__vcElem = {
        resolve: function (path) {
          var n = document.documentElement;
          if (path) {
            var parts = path.split('.');
            for (var i = 0; i < parts.length; i++) {
              n = n.children[Number(parts[i])];
              if (!n) { return null; }
            }
          }
          return n;
        },
        hidden: function (el) {
          var n = el;
          while (n) {
            if (n.id === '__vconsole') { return true; }
            n = n.parentElement;
          }
          return false;
        },
        summary: function (el, path) {
          var a = {};
          var list = el.attributes || [];
          var na = Math.min(list.length, 10);
          for (var i = 0; i < na; i++) { a[list[i].name] = String(list[i].value).slice(0, 60); }
          var out = { p: path, t: (el.tagName || '?').toLowerCase(), a: a, cc: el.childElementCount };
          if (el.id) { out.i = el.id; }
          var cls = el.getAttribute('class');
          if (cls) { out.c = String(cls).slice(0, 60); }
          if (el.childElementCount === 0) {
            var tx = String(el.textContent || '').slice(0, 80);
            if (tx) { out.x = tx; }
          }
          return out;
        }
      };
    }
    var E = W.__vcElem;
    if (op === 'tree') {
      var el = E.resolve(arg.path || '');
      if (!el) { return JSON.stringify({ error: 'node not found' }); }
      var kids = [];
      for (var i = 0; i < el.children.length; i++) {
        if (!E.hidden(el.children[i])) { kids.push(i); }
      }
      var offset = arg.offset || 0;
      var end = Math.min(offset + Math.min(arg.limit || 12, 20), kids.length);
      var out = { self: E.summary(el, arg.path || ''), total: kids.length, offset: offset, ch: [], next: null };
      var next = null;
      for (var j = offset; j < end; j++) {
        out.ch.push(E.summary(el.children[kids[j]], (arg.path ? arg.path + '.' : '') + kids[j]));
        if (JSON.stringify(out).length > 1800 && out.ch.length > 1) {
          out.ch.pop();
          next = j;
          break;
        }
      }
      if (next === null && end < kids.length) { next = end; }
      out.next = next;
      return JSON.stringify(out);
    }
    if (op === 'html') {
      var el2 = E.resolve(arg.path || '');
      if (!el2) { return JSON.stringify({ error: 'node not found' }); }
      var html = '';
      try { html = String(el2.outerHTML); } catch (e) { html = '[outerHTML error]'; }
      var cut = html.length > 20000;
      W.__vcElemHtml = cut ? html.slice(0, 20000) : html;
      return JSON.stringify({ len: W.__vcElemHtml.length, cut: cut, s0: W.__vcElemHtml.slice(0, 1800) });
    }
    if (op === 'hslice') {
      return JSON.stringify({ s: String(W.__vcElemHtml || '').slice(arg.i, arg.i + 1800) });
    }
    return JSON.stringify({ error: 'unknown op' });
  }

  async function runElementSnippet(op, arg) {
    const expr = '(' + elementSnippet.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')';
    const d = await api('eval_js', { expression: expr }, current);
    if (d.isException) { throw new Error(d.result); }
    return JSON.parse(d.result);
  }

  function elemMsg(text) {
    document.getElementById('elem-msg').textContent = text || '';
  }

  async function fetchChildren(path) {
    const node = elemNodes[path];
    let offset = 0;
    for (let guard = 0; guard < 60; guard++) {
      const r = await runElementSnippet('tree', { path, offset, limit: 12 });
      if (r.error) { throw new Error(r.error); }
      Object.assign(node, r.self, { loaded: true });
      for (const s of r.ch) {
        if (!elemNodes[s.p]) { elemNodes[s.p] = Object.assign({ loaded: false, expanded: false, children: [] }, s); }
        node.children.push(s.p);
      }
      if (r.next === null || r.next === undefined) { return; }
      offset = r.next;
    }
    throw new Error('子节点过多，展开中断');
  }

  async function ensureElement() {
    if (elemNodes[''] && elemNodes[''].loaded) { renderElement(); return; }
    await loadElementRoot();
  }

  async function loadElementRoot() {
    document.getElementById('elem-spin').textContent = '…';
    elemMsg('');
    try {
      elemNodes = { '': { p: '', loaded: false, expanded: true, children: [] } };
      closeElemDetail();
      await fetchChildren('');
      renderElement();
    } catch (e) {
      elemMsg('采集失败: ' + e.message);
    }
    document.getElementById('elem-spin').textContent = '';
  }

  function elemRowHtml(n, depth) {
    const toggle = n.cc > 0 ? (n.expanded ? '▾' : '▸') : '·';
    const ident = (n.i ? '#' + esc(n.i) : '') + (n.c ? '.' + esc(String(n.c).split(' ').join('.')) : '');
    const x = n.x ? '<span class="elem-x">' + esc(n.x) + '</span>' : '';
    return '<div class="elem-row' + (elemSelected === n.p ? ' sel' : '') + '" data-p="' + esc(n.p) + '" style="padding-left:' + (6 + depth * 14) + 'px">' +
      '<span class="elem-tg" data-act="toggle">' + toggle + '</span>' +
      '<span><span class="elem-tag">&lt;' + esc(n.t) + '&gt;</span>' +
      (ident ? '<span class="muted"> ' + ident + '</span>' : '') +
      (n.cc > 0 ? '<span class="muted"> (' + n.cc + ')</span>' : '') + '</span>' +
      x + '</div>';
  }

  function renderElement() {
    const body = document.getElementById('elem-body');
    if (!elemNodes[''] || !elemNodes[''].loaded) { body.innerHTML = '<span class="muted">loading…</span>'; return; }
    const rows = [];
    const walk = (path, depth) => {
      const n = elemNodes[path];
      if (!n) { return; }
      rows.push(elemRowHtml(n, depth));
      if (n.expanded && rows.length < 3000) {
        for (const cp of (n.children || [])) { walk(cp, depth + 1); }
      }
    };
    walk('', 0);
    body.innerHTML = rows.join('');
  }

  async function toggleElem(path) {
    const n = elemNodes[path];
    if (!n || n.cc === 0) { return; }
    if (!n.loaded) {
      document.getElementById('elem-spin').textContent = '…';
      try { await fetchChildren(path); } catch (e) { elemMsg('展开失败: ' + e.message); return; }
      document.getElementById('elem-spin').textContent = '';
    }
    n.expanded = !n.expanded;
    renderElement();
  }

  async function selectElem(path) {
    elemSelected = path;
    const n = elemNodes[path];
    renderElement();
    document.getElementById('elem-detail').classList.add('on');
    document.getElementById('elem-detail-title').textContent = '<' + (n ? n.t : '?') + '> ' + path;
    document.getElementById('elem-detail-pre').textContent = 'loading…';
    try {
      const head = await runElementSnippet('html', { path });
      if (head.error) { throw new Error(head.error); }
      let html = head.s0 || '';
      for (let i = 1800; i < head.len; i += 1800) {
        const r = await runElementSnippet('hslice', { i });
        html += r.s;
      }
      elemDetailText = html;
      document.getElementById('elem-detail-pre').textContent = html + (head.cut ? '\\n…[已截断：原始 outerHTML 超过 20000 字符]' : '');
    } catch (e) {
      document.getElementById('elem-detail-pre').textContent = '加载失败: ' + e.message;
    }
  }

  function closeElemDetail() {
    document.getElementById('elem-detail').classList.remove('on');
    elemDetailText = '';
  }

  function copyElemHtml(btn) { copyText(elemDetailText, btn); }

  document.getElementById('elem-body').addEventListener('click', async (e) => {
    const row = e.target.closest('.elem-row');
    if (!row) { return; }
    const p = row.dataset.p;
    if (e.target.closest('.elem-tg')) { await toggleElem(p); return; }
    await selectElem(p);
  });

  // --- vue tab (eval-driven component tree, Vue 3) -------------------------
  // Same transport contract as the element tab: responses are display-strings
  // and serializeOne truncates eval results at 2000 chars, so every op
  // paginates or chunks under 1800. Detection walks __vue_app__ (assigned
  // unconditionally on mount containers even in production builds) — the
  // devtools global hook is dev-only and absent on prod pages. Reads of
  // reactive state trigger getters, so every key is wrapped in try/catch and
  // depth/entry/char budgets apply.
  let vueNodes = {};
  let vueApps = null;
  let vueSelected = null;
  let vueDetailText = '';

  function vueSnippet(op, arg) {
    var W = window;
    if (!W.__vcVue) {
      W.__vcVue = {
        name: function (inst) {
          var t = inst && inst.type;
          return (t && (t.name || t.__name)) || 'Anonymous';
        },
        tagOf: function (inst) {
          try {
            var el = inst.subTree && inst.subTree.el;
            return el && el.nodeType === 1 ? el.tagName.toLowerCase() : '';
          } catch (e) { return ''; }
        },
        kids: function (inst) {
          var out = [];
          (function walk(v) {
            if (!v || typeof v !== 'object') { return; }
            if (v.component) { out.push(v.component); return; }
            if (v.suspense && v.suspense.activeBranch) { walk(v.suspense.activeBranch); return; }
            var ch = v.children;
            if (Array.isArray(ch)) {
              for (var i = 0; i < ch.length; i++) { walk(ch[i]); }
            }
          })(inst.subTree);
          return out;
        },
        findApps: function () {
          var out = [];
          var seen = [];
          function push(entry) {
            var key = entry.v === 3 ? entry.app : entry.vm;
            for (var j = 0; j < seen.length; j++) { if (seen[j] === key) { return; } }
            seen.push(key);
            out.push(entry);
          }
          var els = document.querySelectorAll('[data-v-app], #app');
          for (var i = 0; i < els.length; i++) {
            if (els[i].__vue_app__ && els[i].__vue_app__._instance) { push({ v: 3, app: els[i].__vue_app__, container: els[i] }); }
          }
          // Vue 2 sets el.__vue__ on the mount container unconditionally, even
          // in production builds (_isVue guards against same-name accidents).
          // _update re-stamps it on EVERY component's $el, so only instances
          // without $parent are real app roots.
          var all = document.body ? document.body.getElementsByTagName('*') : [];
          var cap = Math.min(all.length, 400);
          for (var k = 0; k < cap; k++) {
            if (all[k].__vue_app__ && all[k].__vue_app__._instance) { push({ v: 3, app: all[k].__vue_app__, container: all[k] }); }
            if (all[k].__vue__ && all[k].__vue__._isVue && !all[k].__vue__.$parent) { push({ v: 2, vm: all[k].__vue__, container: all[k] }); }
          }
          return out;
        },
        name2: function (vm) {
          var o = vm && vm.$options;
          return (o && (o.name || o._componentTag)) || 'Anonymous';
        },
        tagOf2: function (vm) {
          try {
            return vm.$el && vm.$el.nodeType === 1 ? vm.$el.tagName.toLowerCase() : '';
          } catch (e) { return ''; }
        },
        resolve2: function (vm, path) {
          var inst = vm;
          if (path) {
            var segs = path.split('.');
            for (var i = 0; i < segs.length; i++) {
              inst = inst.$children[Number(segs[i])];
              if (!inst) { return null; }
            }
          }
          return inst;
        },
        grabObj: function (obj) {
          if (!obj || typeof obj !== 'object') { return null; }
          var o = {};
          var ks = Object.keys(obj);
          for (var i = 0; i < Math.min(ks.length, 30); i++) {
            try { o[ks[i]] = W.__vcVue.val(obj[ks[i]], 2); } catch (e) { o[ks[i]] = '[unreadable]'; }
          }
          return o;
        },
        rootInst: function (app, el) {
          // prod builds never assign app._instance (verified on 3.5.13: only
          // unmount reads it); dev builds do, and also tag every patched
          // element with __vueParentComponent — try both, else unreadable
          var inst = app._instance;
          if (!inst && el && el.firstElementChild && el.firstElementChild.__vueParentComponent) {
            inst = el.firstElementChild.__vueParentComponent;
          }
          if (!inst) { return null; }
          try { while (inst.parent) { inst = inst.parent; } } catch (e) { /* keep what we got */ }
          return inst;
        },
        resolveInst: function (app, path) {
          var inst = app._instance;
          if (path) {
            var segs = path.split('.');
            for (var i = 0; i < segs.length; i++) {
              inst = W.__vcVue.kids(inst)[Number(segs[i])];
              if (!inst) { return null; }
            }
          }
          return inst;
        },
        val: function (v, depth) {
          if (v === null) { return null; }
          var t = typeof v;
          if (t === 'string') { return v.length > 120 ? v.slice(0, 120) + '…' : v; }
          if (t === 'number' || t === 'boolean') { return v; }
          if (t === 'function') { return '[fn]'; }
          if (t === 'object') {
            if (depth <= 0) { return Array.isArray(v) ? '[…' + v.length + ']' : '{…}'; }
            try {
              if (v.__v_isRef) { return W.__vcVue.val(v.value, depth); }
              if (v instanceof Date) { return v.toISOString(); }
              if (typeof Element !== 'undefined' && v instanceof Element) { return '<' + v.tagName.toLowerCase() + '>'; }
              if (Array.isArray(v)) {
                var r = [];
                var n = Math.min(v.length, 20);
                for (var i = 0; i < n; i++) { r.push(W.__vcVue.val(v[i], depth - 1)); }
                if (v.length > 20) { r.push('…+' + (v.length - 20)); }
                return r;
              }
              var o = {};
              var ks = Object.keys(v);
              var nk = Math.min(ks.length, 20);
              for (var j = 0; j < nk; j++) {
                try { o[ks[j]] = W.__vcVue.val(v[ks[j]], depth - 1); } catch (e) { o[ks[j]] = '[unreadable]'; }
              }
              if (ks.length > 20) { o['…'] = '+' + (ks.length - 20); }
              return o;
            } catch (e2) { return '[unreadable]'; }
          }
          return String(v).slice(0, 60);
        },
        stateOf: function (inst) {
          return { props: E.grabObj(inst.props), setup: E.grabObj(inst.setupState), data: E.grabObj(inst.data) };
        },
        // Vue 2.7's composition API keeps setup state on _setupState when present
        stateOf2: function (vm) {
          return { props: E.grabObj(vm.$props), data: E.grabObj(vm._data), setup: E.grabObj(vm._setupState) };
        },
      };
    }
    var E = W.__vcVue;
    if (op === 'apps') {
      var found = E.findApps();
      var apps = [];
      for (var i = 0; i < found.length; i++) {
        var f = found[i];
        var name = '?';
        var tag = '';
        var readable = true;
        if (f.v === 3) {
          var root = E.rootInst(f.app, f.container);
          name = root ? E.name(root) : '(unknown)';
          tag = root ? E.tagOf(root) : '';
          readable = !!root;
        } else {
          name = E.name2(f.vm);
          tag = E.tagOf2(f.vm);
        }
        apps.push({
          i: apps.length,
          v: f.v,
          name: name,
          tag: tag,
          container: (f.container.tagName || '').toLowerCase() + (f.container.id ? '#' + f.container.id : ''),
          readable: readable,
        });
      }
      W.__vcVueApps = found;
      return JSON.stringify({ apps: apps });
    }
    if (op === 'tree') {
      var entry = (W.__vcVueApps || [])[arg.app];
      if (!entry) { return JSON.stringify({ error: 'app not found, 请刷新' }); }
      var inst = entry.v === 3
        ? (arg.path ? E.resolveInst(entry.app, arg.path) : E.rootInst(entry.app, entry.container))
        : E.resolve2(entry.vm, arg.path || '');
      if (!inst) { return JSON.stringify({ error: 'instance not found, 请刷新' }); }
      var kids = entry.v === 3 ? E.kids(inst) : inst.$children;
      var offset = arg.offset || 0;
      var end = Math.min(offset + Math.min(arg.limit || 12, 20), kids.length);
      var out = { total: kids.length, offset: offset, ch: [], next: null };
      var next = null;
      for (var j = offset; j < end; j++) {
        var c = kids[j];
        out.ch.push({
          n: entry.v === 3 ? E.name(c) : E.name2(c),
          tag: entry.v === 3 ? E.tagOf(c) : E.tagOf2(c),
          cc: entry.v === 3 ? E.kids(c).length : c.$children.length,
        });
        if (JSON.stringify(out).length > 1800 && out.ch.length > 1) { out.ch.pop(); next = j; break; }
      }
      if (next === null && end < kids.length) { next = end; }
      out.next = next;
      return JSON.stringify(out);
    }
    if (op === 'state') {
      var entry2 = (W.__vcVueApps || [])[arg.app];
      if (!entry2) { return JSON.stringify({ error: 'app not found, 请刷新' }); }
      var inst2 = entry2.v === 3
        ? (arg.path ? E.resolveInst(entry2.app, arg.path) : E.rootInst(entry2.app, entry2.container))
        : E.resolve2(entry2.vm, arg.path || '');
      if (!inst2) { return JSON.stringify({ error: 'instance not found, 请刷新' }); }
      var st = entry2.v === 3 ? E.stateOf(inst2) : E.stateOf2(inst2);
      var text = JSON.stringify(st);
      var cut = text.length > 20000;
      W.__vcVueState = cut ? text.slice(0, 20000) : text;
      return JSON.stringify({
        name: entry2.v === 3 ? E.name(inst2) : E.name2(inst2),
        len: W.__vcVueState.length,
        cut: cut,
        s0: W.__vcVueState.slice(0, 1800),
      });
    }
    if (op === 'sslice') {
      return JSON.stringify({ s: String(W.__vcVueState || '').slice(arg.i, arg.i + 1800) });
    }
    return JSON.stringify({ error: 'unknown op' });
  }

  async function runVueSnippet(op, arg) {
    const expr = '(' + vueSnippet.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')';
    const d = await api('eval_js', { expression: expr }, current);
    if (d.isException) { throw new Error(d.result); }
    return JSON.parse(d.result);
  }

  function vueMsg(text) { document.getElementById('vue-msg').textContent = text || ''; }

  async function fetchVueChildren(path) {
    const node = vueNodes[path];
    const parts = path.split('.');
    let offset = 0;
    for (let guard = 0; guard < 60; guard++) {
      const r = await runVueSnippet('tree', { app: Number(parts[0]), path: parts.slice(1).join('.'), offset, limit: 12 });
      if (r.error) { throw new Error(r.error); }
      for (let j = 0; j < r.ch.length; j++) {
        const cp = path + '.' + (offset + j);
        if (!vueNodes[cp]) { vueNodes[cp] = Object.assign({ p: cp, loaded: false, expanded: false, children: [] }, r.ch[j]); }
        node.children.push(cp);
      }
      if (r.next === null || r.next === undefined) { node.cc = node.children.length; return; }
      offset = r.next;
    }
    throw new Error('子组件过多，展开中断');
  }

  async function ensureVue() {
    if (vueApps) { renderVue(); return; }
    await loadVueRoot();
  }

  async function loadVueRoot() {
    document.getElementById('vue-spin').textContent = '…';
    vueMsg('');
    try {
      const r = await runVueSnippet('apps', {});
      vueNodes = {};
      closeVueDetail();
      if (!r.apps.length) {
        vueApps = null;
        renderVue();
        document.getElementById('vue-body').innerHTML = '<span class="muted">未检测到 Vue 应用（Vue 3 按 __vue_app__ / [data-v-app] 探测，Vue 2 按 __vue__ 探测）</span>';
        return;
      }
      vueApps = r.apps;
      for (const a of r.apps) {
        vueNodes[String(a.i)] = { p: String(a.i), n: a.name, tag: a.tag, v: a.v, cc: 0, loaded: false, expanded: true, children: [] };
      }
      for (const a of r.apps) {
        if (a.readable) { await fetchVueChildren(String(a.i)); }
      }
      if (!r.apps.some((a) => a.readable)) {
        renderVue();
        document.getElementById('vue-body').innerHTML = '<div class="muted" style="padding:8px">检测到 Vue 3 应用（生产构建）。组件树与状态需要开发构建的页面——Vue 3 只在开发运行时暴露组件实例（vite dev 页面或非 prod 的 Vue 包均可）。Vue 2 无此限制。</div>';
        return;
      }
      renderVue();
    } catch (e) {
      vueMsg('采集失败: ' + e.message);
    }
    document.getElementById('vue-spin').textContent = '';
  }

  function vueRowHtml(n, depth) {
    const toggle = n.cc > 0 ? (n.expanded ? '▾' : '▸') : '·';
    const tag = n.tag ? '<span class="muted"> &lt;' + esc(n.tag) + '&gt;</span>' : '';
    const badge = depth === 0 && n.v ? '<span class="muted"> v' + n.v + '</span>' : '';
    return '<div class="elem-row' + (vueSelected === n.p ? ' sel' : '') + '" data-p="' + esc(n.p) + '" style="padding-left:' + (6 + depth * 14) + 'px">' +
      '<span class="elem-tg" data-act="toggle">' + toggle + '</span>' +
      '<span><span class="elem-tag">' + esc(n.n || 'Anonymous') + '</span>' + badge + tag + '</span>' +
      (n.cc > 0 ? '<span class="muted"> (' + n.cc + ')</span>' : '') + '</div>';
  }

  function renderVue() {
    const body = document.getElementById('vue-body');
    if (vueApps === null) { body.innerHTML = '<span class="muted">打开 Vue 标签后从页面采集</span>'; return; }
    const rows = [];
    const walk = (path, depth) => {
      const n = vueNodes[path];
      if (!n) { return; }
      rows.push(vueRowHtml(n, depth));
      if (n.expanded && rows.length < 3000) {
        for (const cp of (n.children || [])) { walk(cp, depth + 1); }
      }
    };
    for (const a of vueApps) { walk(String(a.i), 0); }
    body.innerHTML = rows.join('');
  }

  async function toggleVue(path) {
    const n = vueNodes[path];
    if (!n || n.cc === 0) { return; }
    if (!n.loaded) {
      document.getElementById('vue-spin').textContent = '…';
      try { await fetchVueChildren(path); } catch (e) { vueMsg('展开失败: ' + e.message); return; }
      document.getElementById('vue-spin').textContent = '';
    }
    n.expanded = !n.expanded;
    renderVue();
  }

  async function selectVue(path) {
    vueSelected = path;
    const n = vueNodes[path];
    renderVue();
    document.getElementById('vue-detail').classList.add('on');
    document.getElementById('vue-detail-title').textContent = (n ? n.n : '?') + ' 组件状态';
    document.getElementById('vue-detail-pre').textContent = 'loading…';
    try {
      const parts = path.split('.');
      const head = await runVueSnippet('state', { app: Number(parts[0]), path: parts.slice(1).join('.') });
      if (head.error) { throw new Error(head.error); }
      let text = head.s0 || '';
      for (let i = 1800; i < head.len; i += 1800) {
        const r = await runVueSnippet('sslice', { i });
        text += r.s;
      }
      vueDetailText = text;
      document.getElementById('vue-detail-pre').textContent = text + (head.cut ? '\\n…[已截断：状态文本超过 20000 字符]' : '');
    } catch (e) {
      document.getElementById('vue-detail-pre').textContent = '加载失败: ' + e.message;
    }
  }

  function closeVueDetail() {
    document.getElementById('vue-detail').classList.remove('on');
    vueDetailText = '';
  }

  function copyVueState(btn) { copyText(vueDetailText, btn); }

  document.getElementById('vue-body').addEventListener('click', async (e) => {
    const row = e.target.closest('.elem-row');
    if (!row) { return; }
    const p = row.dataset.p;
    if (e.target.closest('.elem-tg')) { await toggleVue(p); return; }
    await selectVue(p);
  });

  let stoData = null;
  let stoEditing = null;


  function renderStorage() {
    const row = (kind, k, v) => {
      const editing = stoEditing && stoEditing.kind === kind && stoEditing.key === k;
      return '<tr data-s="' + kind + '" data-k="' + esc(k) + '"><td class="k">' + esc(k) + '</td><td>' +
        (editing ? '<textarea id="sto-edit" rows="3">' + esc(v) + '</textarea>' : esc(v)) + '</td>' +
        '<td class="ops">' +
        (editing ? '<div class="sto-acts"><button data-act="save">保存</button> <button data-act="cancel">取消</button></div>'
                 : '<button data-act="edit">修改</button> <button data-act="del">删除</button>') + '</td></tr>';
    };
    const block = (kind, title, obj) => {
      const entries = Object.entries(obj || {});
      return '<b style="font-size:12px">' + title + '</b><table class="headers"><tbody>' +
        (entries.length ? entries.map(([k, v]) => row(kind, k, v)).join('')
                        : '<tr><td colspan="3" class="muted">空</td></tr>') +
        '</tbody></table>';
    };
    document.getElementById('sto-body').innerHTML =
      block('cookie', 'Cookies', stoData.cookies) +
      block('local', 'localStorage', stoData.localStorage) +
      block('session', 'sessionStorage', stoData.sessionStorage);
    if (stoEditing) { const i = document.getElementById('sto-edit'); if (i) { i.focus(); i.select(); } }
  }

  let lastStoLoad = 0;
  function maybeRefreshStorage() {
    if (!current) { return; }
    if (!document.getElementById('pane-storage').classList.contains('on')) { return; }
    if (stoEditing) { return; } // never clobber an open editor
    const now = Date.now();
    if (now - lastStoLoad < 1500) { return; } // get_storage is a page round-trip
    lastStoLoad = now;
    loadStorage();
  }

  async function loadStorage() {
    if (!current) { return; }
    document.getElementById('sto-spin').textContent = '…';
    try {
      stoData = await api('get_storage', {}, current);
      stoEditing = null;
      renderStorage();
    } catch (e) {
      document.getElementById('sto-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
    document.getElementById('sto-spin').textContent = '';
  }

  async function saveStorage(kind, key) {
    const input = document.getElementById('sto-edit');
    const msg = document.getElementById('sto-msg');
    msg.textContent = '写入中…';
    try {
      const r = await api('set_storage', { storage: kind, key, value: input ? input.value : '' }, current);
      await loadStorage();
      msg.textContent = key + ' = ' + r.value;
    } catch (e) {
      msg.textContent = '';
      document.getElementById('sto-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
  }

  async function delStorage(kind, key) {
    const msg = document.getElementById('sto-msg');
    msg.textContent = '删除中…';
    try {
      const r = await api('del_storage', { storage: kind, key }, current);
      await loadStorage();
      msg.textContent = key + (r.deleted ? ' 已删除' : ' 删除失败（可能 HttpOnly）');
    } catch (e) {
      msg.textContent = '';
      document.getElementById('sto-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
  }

  document.getElementById('sto-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) { return; }
    const tr = btn.closest('tr');
    const kind = tr.dataset.s, key = tr.dataset.k;
    if (btn.dataset.act === 'edit') { stoEditing = { kind, key }; renderStorage(); }
    else if (btn.dataset.act === 'cancel') { stoEditing = null; renderStorage(); }
    else if (btn.dataset.act === 'save') { saveStorage(kind, key); }
    else if (btn.dataset.act === 'del') { delStorage(kind, key); }
  });

  async function runEval() {
    const expr = document.getElementById('eval-expr').value;
    if (!expr || !current) { return; }
    const out = document.getElementById('eval-out');
    out.textContent = 'running…';
    try {
      const d = await api('eval_js', { expression: expr }, current);
      out.innerHTML = '<pre>' + (d.isException ? '⚠ ' : '→ ') + esc(d.result) + '</pre><span class="muted">' + d.durationMs + 'ms</span>';
    } catch (e) {
      out.innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
  }

  async function loadShot() {
    if (!current) { return; }
    document.getElementById('shot-spin').textContent = '…';
    document.getElementById('shot-body').textContent = 'rendering…';
    try {
      const r = await fetch('/api/tool' + TQ, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'screenshot', args: { format: 'png' }, sessionId: current }) });
      const result = await r.json();
      const img = result.content && result.content[0];
      if (img && img.type === 'image') {
        document.getElementById('shot-body').innerHTML = '<img class="shot" src="data:' + img.mimeType + ';base64,' + img.data + '">';
      } else {
        document.getElementById('shot-body').innerHTML = '<span class="lv-error">' + esc((result.content[0] || {}).text || 'failed') + '</span>';
      }
    } catch (e) {
      document.getElementById('shot-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
    document.getElementById('shot-spin').textContent = '';
  }

  let lastInfo = null;

  async function loadInfo() {
    if (!current) { return; }
    try {
      const d = await api('get_page_info', {}, current);
      lastInfo = d;
      const row = (k, v) => '<tr><th>' + k + '</th><td>' + esc(v) + '</td></tr>';
      document.getElementById('info-body').innerHTML =
        '<table class="headers"><tbody>' +
        row('URL', d.url) + row('Title', d.title) + row('UA', d.userAgent) +
        row('Viewport', d.viewport.width + '×' + d.viewport.height + ' @' + d.viewport.dpr) +
        row('Screen', d.screen.width + '×' + d.screen.height) +
        row('Online', d.online) + row('Visibility', d.visibility) +
        (d.memory ? row('JS Heap', (d.memory.usedJsHeapSize / 1048576).toFixed(1) + ' / ' + (d.memory.totalJsHeapSize / 1048576).toFixed(1) + ' MB') : '') +
        (d.navigation ? row('Timing', 'TTFB ' + d.navigation.ttfbMs + 'ms · DCL ' + d.navigation.domContentLoadedMs + 'ms · load ' + d.navigation.loadMs + 'ms') : '') +
        '</tbody></table>';
    } catch (e) {
      lastInfo = null;
      document.getElementById('info-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
  }

  // same rows the System table shows, as plain "key: value" lines
  function copyInfo(btn) {
    const d = lastInfo;
    if (!d) { flashBtn(btn, '无数据'); return; }
    const lines = ['URL: ' + d.url, 'Title: ' + d.title, 'UA: ' + d.userAgent,
      'Viewport: ' + d.viewport.width + '×' + d.viewport.height + ' @' + d.viewport.dpr,
      'Screen: ' + d.screen.width + '×' + d.screen.height,
      'Online: ' + d.online, 'Visibility: ' + d.visibility];
    if (d.memory) { lines.push('JS Heap: ' + (d.memory.usedJsHeapSize / 1048576).toFixed(1) + ' / ' + (d.memory.totalJsHeapSize / 1048576).toFixed(1) + ' MB'); }
    if (d.navigation) { lines.push('Timing: TTFB ' + d.navigation.ttfbMs + 'ms · DCL ' + d.navigation.domContentLoadedMs + 'ms · load ' + d.navigation.loadMs + 'ms'); }
    copyText(lines.join('\\n'), btn);
  }

  // live feed (SSE) with polling fallback: /api/events pushes a sessions
  // snapshot plus which session/kinds changed; while it is healthy the 1s
  // poller stands down completely (idle = zero traffic)
  let sseHealthy = false;
  try {
    const es = new EventSource('/api/events' + TQ);
    es.onopen = () => { sseHealthy = true; };
    es.onerror = () => { sseHealthy = false; }; // EventSource retries on its own
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.sessions) { renderSessions(msg.sessions); }
      const hit = (msg.touched || []).find((t) => t.sessionId === current);
      if (hit) {
        // logs: always live (SSE). network: only while its pane is visible.
        // storage: page activity hints at possible writes — refresh it too
        // (throttled, skipped mid-edit); the manual button covers silent writes.
        if (hit.kinds.indexOf('logs') > -1) { loadLogs(); }
        if (hit.kinds.indexOf('network') > -1 && document.getElementById('pane-network').classList.contains('on')) { loadNetwork(); }
        if (hit.kinds.indexOf('logs') > -1 || hit.kinds.indexOf('network') > -1) { maybeRefreshStorage(); }
      }
    };
  } catch (e) { /* no EventSource: the poller below handles everything */ }

  setInterval(() => {
    if (sseHealthy) { return; }
    renderSessions();
    if (current) { loadLogs(); }
  }, 1000);
  document.getElementById('mcp-conf').textContent = MCP_CONF;
  renderSessions();
</script>
</body>
</html>`;
}

module.exports.splitCardText = splitCardText;
