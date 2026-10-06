/**
 * The device panel + per-session debugging drawer, served on :9527.
 *
 * Left: session list (from list_sessions, in connection order). Click a
 * session → a right-side drawer with vConsole-style tabs: System / Logs /
 * Network / Storage / Screenshot. The JS console input lives at the bottom of
 * the Logs tab. Everything runs through the same tool backend the MCP clients
 * use, targeted at the selected session (no element tab by design).
 *
 * Deliberately hand-rolled instead of embedding the fork's svelte components:
 * the on-page vConsole UI is hard-wired to its in-page stores, and a remote
 * renderer only needs the tool API. (chii made the same call for eruda.)
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
</style>
</head>
<body>
  <div id="list">
    <header>
      <h1>设备列表</h1>
      <span id="hub">connecting…</span>
      <details id="mcp-help">
        <summary>MCP配置</summary>
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
      <button data-t="storage">Storage</button>
      <button data-t="screenshot">Screenshot</button>
    </div>
    <div class="pane on" id="pane-info">
      <div class="toolbar"><button onclick="loadInfo()">刷新</button></div>
      <div id="info-body"></div>
    </div>
    <div class="pane" id="pane-logs">
      <div class="toolbar">
        <select id="log-level"><option value="">all levels</option><option>log</option><option>info</option><option>warn</option><option>error</option><option>debug</option></select>
        <input id="log-kw" placeholder="keyword…" style="width:160px">
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
  let lastNet = null;
  let lastCards = '';
  const netCache = {};
  // injected from the Node-side definition above so panel and unit test share one implementation
  const splitCardText = ${splitCardText.toString()};
  // a panel opened from another machine must carry the hub token it was handed
  // in its own URL; on the dev machine (loopback) there is nothing to carry
  const T = new URLSearchParams(location.search).get('t') || '';
  const TQ = T ? '?t=' + encodeURIComponent(T) : '';

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
    renderSessions();
    document.getElementById('drawer').classList.add('open');
    document.getElementById('d-sid').textContent = id;
    selectTab('info');
    loadLogs(); loadNetwork(); loadStorage(); loadInfo();
    document.getElementById('shot-body').innerHTML = '<span class="muted">点击"截图"按钮生成</span>';
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
      box.innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
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
        (d.replayedFrom ? ' · 重放自 ' + esc(d.replayedFrom) : '') + '</p>' +
      querySection(d.url) +
      headerSection('请求标头', d.requestHeader) +
      headerSection('响应标头', d.responseHeader) +
      payloadSection('请求载荷', d.postData) +
      payloadSection('响应内容', d.response) +
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

  function headerSection(title, text) {
    if (text == null || text === '') { return ''; }
    const pairs = parseHeaders(text);
    if (!pairs.length) {
      return '<details class="hsec" open><summary>' + title + '</summary>' +
        '<pre class="raw">' + esc(String(text)) + '</pre></details>';
    }
    const tbl = '<div class="tbl"><table class="headers"><tbody>' +
      pairs.map((kv) => '<tr><th>' + esc(kv[0]) + '</th><td>' + esc(kv[1]) + '</td></tr>').join('') +
      '</tbody></table></div>';
    return '<details class="hsec" open><summary>' + title + '</summary>' + tbl + '</details>';
  }

  function payloadSection(title, text) {
    if (text == null || text === '') { return ''; }
    return '<details class="hsec" open><summary>' + title + '</summary>' +
      '<pre class="raw">' + esc(String(text)) + '</pre></details>';
  }

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

  async function loadInfo() {
    if (!current) { return; }
    try {
      const d = await api('get_page_info', {}, current);
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
      document.getElementById('info-body').innerHTML = '<span class="lv-error">' + esc(e.message) + '</span>';
    }
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
  document.getElementById('mcp-conf').textContent = JSON.stringify({
    mcpServers: { vconsole: { type: 'http', url: 'http://' + location.host + '/mcp' + TQ } },
  }, null, 2);
  renderSessions();
</script>
</body>
</html>`;
}

module.exports.splitCardText = splitCardText;
