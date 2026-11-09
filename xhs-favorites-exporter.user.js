// ==UserScript==
// @name         小紅書收藏匯出器 (XHS Favorites Exporter)
// @namespace    xhs-local-tools
// @version      0.3.0
// @description  自動慢速滾動加載收藏、偵測「薯隊長」錯誤自動冷卻重試、依收藏夾名稱分類,一鍵複製 JSON 貼到「收藏管理台」。
// @author       you
// @match        *://*.xiaohongshu.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* ============================================================
  v0.3.0 更新
  - ▶ 自動滾動:以每輪 1.6~4 秒的隨機節奏慢慢加載,取代「按住下鍵」。
    (按住下鍵 = 短時間狂發載入請求,是「薯隊長出了點問題」的主因)
  - 錯誤偵測:出現「薯隊長」錯誤頁時自動暫停、冷卻 6~10 秒再續;
    連續 3 次會嘗試自動點擊頁面上的「刷新/重試」,再不行才停止。
  - 收藏夾分類:面板新增「收藏夾」輸入框(自動偵測、可手動改、
    按網址記住),掃到的筆記會帶上這個標籤,匯入管理台自動建分類。
  - 邊滾邊掃:防止清單過長時舊卡片被虛擬列表回收。

  為什麼之前沒有分類?收藏列表的卡片 DOM 只有 標題/封面/作者,
  「屬於哪個收藏夾」和「#話題標籤」都不在上面(標籤只在筆記詳情頁)。
  所以分類要嘛靠收藏夾名稱(本版),要嘛靠管理台的關鍵字規則。
============================================================ */

(function () {
  'use strict';

  // 診斷訊息:開 F12 Console 看到這行 = 腳本有被注入
  console.log('[XHS匯出器] v0.3.0 已載入 →', location.href);

  var LS_KEY = 'xhs_tm_favorites';
  var LS_FOLDER_MAP = 'xhs_tm_folder_names'; // 網址 → 收藏夾名稱
  var MAX_STORE = 5000;

  /* ---------- LocalStorage ---------- */
  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function save(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list.slice(-MAX_STORE)));
      return true;
    } catch (e) {
      alert('寫入 LocalStorage 失敗(可能已滿):' + e.message);
      return false;
    }
  }
  function folderMapLoad() {
    try { return JSON.parse(localStorage.getItem(LS_FOLDER_MAP) || '{}'); }
    catch (e) { return {}; }
  }
  function folderMapSave(m) {
    try { localStorage.setItem(LS_FOLDER_MAP, JSON.stringify(m)); } catch (e) {}
  }
  function pageKey() { return location.pathname + location.search; }

  /* ---------- 「薯隊長」錯誤偵測 ---------- */
  function errorActive() {
    try {
      var t = document.body ? document.body.textContent : '';
      // 簡體「薯队长」/ 繁體「薯隊長」都認
      return t.indexOf('薯队长') !== -1 || t.indexOf('薯隊長') !== -1;
    } catch (e) { return false; }
  }
  function clickRetry() {
    // 盡力找「刷新 / 重新加载 / 重试」按鈕點下去
    var texts = ['刷新', '重新加载', '重新載入', '点击重试', '點擊重試', '重试', '重試'];
    var els = document.querySelectorAll('button, a, div[role="button"], span');
    for (var i = 0; i < els.length; i++) {
      var txt = (els[i].textContent || '').trim();
      if (texts.indexOf(txt) !== -1) { els[i].click(); return true; }
    }
    return false;
  }

  /* ---------- 收藏夾名稱 ---------- */
  function detectFolderName() {
    // 1) 這個網址上次用過的名字
    var m = folderMapLoad();
    if (m[pageKey()]) return m[pageKey()];
    // 2) __INITIAL_STATE__ 盡力猜 (結構可能改版,抓不到就算了)
    try {
      var st = window.__INITIAL_STATE__;
      var u = st && st.user;
      var cands = [];
      if (u && u.favFolder) cands.push(u.favFolder.name, u.favFolder.title, u.favFolder.folderName);
      if (u && u.folder) cands.push(u.folder.name, u.folder.title, u.folder.folderName);
      if (u && u.favFolderName) cands.push(u.favFolderName);
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] && typeof cands[i] === 'string' && cands[i].trim()) return cands[i].trim();
      }
    } catch (e) {}
    // 3) DOM 盡力猜:收藏夾頁的大標題
    try {
      var el = document.querySelector('[class*="favTitle"], [class*="folderName"], [class*="folder-name"], [class*="fav-title"]');
      if (el && el.textContent && el.textContent.trim()) return el.textContent.trim().slice(0, 30);
    } catch (e) {}
    return '';
  }
  function currentFolderName() {
    var inp = document.getElementById('xhs-tm-folder');
    var v = inp ? String(inp.value || '').trim() : '';
    if (v) { var m = folderMapLoad(); m[pageKey()] = v; folderMapSave(m); } // 記住這個網址對應的名字
    return v;
  }
  function refreshFolderInput() {
    var inp = document.getElementById('xhs-tm-folder');
    if (inp) inp.value = detectFolderName();
  }

  /* ---------- DOM 收集 (只讀已載入的卡片,不發任何請求) ---------- */
  var NOTE_LINK = /^\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{16,})/;

  function collectFromDOM() {
    var found = {};
    document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]').forEach(function (a) {
      var m = (a.getAttribute('href') || '').match(NOTE_LINK);
      if (!m) return;
      var id = m[1];
      if (found[id]) return;

      var root = a.closest('section, li, div[class]') || a;
      var titleEl =
        root.querySelector('[class*="title"]') ||
        root.querySelector('.title') ||
        a.querySelector('[class*="title"]');
      var title = (titleEl && titleEl.textContent.trim()) || a.getAttribute('title') || '';

      var img = root.querySelector('img') || a.querySelector('img');
      var cover = '';
      if (img) {
        cover = img.currentSrc || img.src || '';
        if (!cover && img.srcset) cover = img.srcset.split(',')[0].trim().split(' ')[0];
      }

      var authorEl = root.querySelector('[class*="author"], .author, .name');
      var author = authorEl ? authorEl.textContent.trim() : '';

      var isVideo = !!root.querySelector('[class*="play"], .play-icon, [class*="video"]');

      found[id] = {
        id: id,
        title: title || '(無標題)',
        url: 'https://www.xiaohongshu.com/explore/' + id,
        cover: cover,
        author: author,
        noteType: isVideo ? 'video' : 'normal',
        category: '',
        scannedAt: new Date().toISOString(),
      };
    });

    // 備援:DOM 抓不到時讀 __INITIAL_STATE__
    if (Object.keys(found).length === 0) {
      try {
        var st = window.__INITIAL_STATE__;
        var notes = st && st.user && st.user.notes;
        if (!notes) notes = st && (st.note || {}).noteList || (st.feed || {}).notes;
        if (Array.isArray(notes)) {
          notes.forEach(function (n) {
            if (!n || !n.noteId) return;
            if (found[n.noteId]) return;
            found[n.noteId] = {
              id: n.noteId,
              title: n.displayTitle || n.title || '(無標題)',
              url: 'https://www.xiaohongshu.com/explore/' + n.noteId,
              cover: (n.cover && (n.cover.url || n.cover.urlDefault)) || '',
              author: (n.user && n.user.nickname) || '',
              noteType: n.type === 'video' ? 'video' : 'normal',
              category: '',
              scannedAt: new Date().toISOString(),
            };
          });
        }
      } catch (e) { /* 結構變了,忽略 */ }
    }
    return found;
  }

  /* 掃描:合併進 LocalStorage (id 去重);silent=true 給自動滾動用,不跳窗 */
  function scan(silent) {
    var found = collectFromDOM();
    var folder = currentFolderName();
    var list = load();
    var map = {};
    for (var i = 0; i < list.length; i++) map[list[i].id] = list[i];

    var added = 0, tagged = 0;
    Object.keys(found).forEach(function (id) {
      var it = found[id];
      if (folder) it.category = folder;
      if (!map[id]) { map[id] = it; added++; }
      else if (folder && !map[id].category) { map[id].category = folder; tagged++; } // 只補空,不覆蓋已分類
    });

    var merged = Object.keys(map).map(function (k) { return map[k]; });
    if (!save(merged)) return 0;
    updateBadge();

    if (!silent) {
      alert('本頁掃描到 ' + Object.keys(found).length + ' 張卡片\n' +
            '新增 ' + added + ' 筆' + (tagged ? ',補上標籤 ' + tagged + ' 筆' : '') + '\n' +
            (folder ? '收藏夾標籤:「' + folder + '」' : '(未設定收藏夾標籤 → 匯入後為未分類)') + '\n' +
            '目前累積 ' + merged.length + ' 筆');
    }
    return merged.length;
  }

  /* ---------- 自動滾動 (慢速隨機節奏 + 錯誤冷卻 + 到底偵測) ---------- */
  var AS = { running: false, timers: [], stall: 0, lastH: -1, errStreak: 0 };

  function setStatus(txt) {
    var el = document.getElementById('xhs-tm-status');
    if (el) el.textContent = txt;
  }
  function wait(ms) { AS.timers.push(setTimeout(step, ms)); }

  function toggleAutoScroll() {
    if (AS.running) { stopAutoScroll('已停止'); return; }
    AS.running = true; AS.stall = 0; AS.lastH = -1; AS.errStreak = 0; AS.timers = [];
    var b = document.getElementById('xhs-tm-scrollbtn');
    if (b) b.textContent = '⏸ 停止滾動';
    setStatus('自動滾動中…');
    step();
  }
  function stopAutoScroll(msg) {
    AS.running = false;
    AS.timers.forEach(clearTimeout);
    AS.timers = [];
    var b = document.getElementById('xhs-tm-scrollbtn');
    if (b) b.textContent = '▶ 自動滾動加載';
    if (msg) setStatus(msg);
    updateBadge();
  }

  function step() {
    if (!AS.running) return;

    // (a) 錯誤頁處理:冷卻 → 重試按鈕 → 放棄
    if (errorActive()) {
      AS.errStreak++;
      if (AS.errStreak >= 3) {
        if (clickRetry()) {
          setStatus('⚠ 連續錯誤,已自動點擊「刷新」,觀察中…');
          AS.errStreak = 0;
          wait(8000);
          return;
        }
        stopAutoScroll('⚠ 已停止(連續錯誤)');
        alert('連續出現「薯隊長」錯誤,已停止自動滾動。\n\n' +
              '這是小紅書的節流訊號 — 已掃描的 ' + load().length + ' 筆不會丟失,\n' +
              '建議休息 1~2 分鐘、重新整理頁面後再按「自動滾動」繼續。');
        return;
      }
      setStatus('⚠ 偵測到「薯隊長」錯誤,冷卻 ' + AS.errStreak + '/3,幾秒後自動重試…');
      wait(6000 + Math.random() * 4000);
      return;
    }
    AS.errStreak = 0;

    // (b) 滾一段 (隨機距離,模擬真人)
    window.scrollBy(0, Math.round(window.innerHeight * (0.7 + Math.random() * 0.5)));

    // (c) 等畫面載入,邊滾邊掃 + 到底偵測
    AS.timers.push(setTimeout(function () {
      if (!AS.running) return;
      scan(true); // 安靜掃描,防虛擬列表回收舊卡片

      var h = document.documentElement.scrollHeight;
      var atBottom = (window.innerHeight + window.scrollY) >= h - 60;
      if (atBottom && h === AS.lastH) AS.stall++; else AS.stall = 0;
      AS.lastH = h;

      if (AS.stall >= 3) {
        stopAutoScroll('✔ 加載完成');
        alert('看起來到底了!累積 ' + load().length + ' 筆。\n\n' +
              '要繼續下一個收藏夾:回去點開它,確認面板「收藏夾」欄的名稱後,\n' +
              '再按一次「▶ 自動滾動加載」即可(名稱會自動記住)。');
        return;
      }
      setStatus('自動滾動中… 累積 ' + load().length + ' 筆');
      wait(1600 + Math.random() * 2400); // 每輪 1.6~4 秒
    }, 800 + Math.random() * 700));
  }

  /* ---------- 匯出 / 複製 ---------- */
  function buildJson() {
    var list = load().map(function (it) {
      return {
        id: it.id, title: it.title, url: it.url, cover: it.cover,
        author: it.author, noteType: it.noteType, category: it.category || '',
      };
    });
    return JSON.stringify({ source: 'xhs-tampermonkey', count: list.length, items: list }, null, 2);
  }
  function copyJson() {
    var list = load();
    if (!list.length) { alert('還沒有資料,先掃描或自動滾動。'); return; }
    var json = buildJson();
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(json, 'text');
      alert('已複製 ' + list.length + ' 筆到剪貼簿!\n打開 xhs-favorites-manager.html 貼到「資料匯入」即可。');
    } else {
      var ta = document.createElement('textarea');
      ta.value = json;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); alert('已複製 ' + list.length + ' 筆到剪貼簿!'); }
      catch (e) { prompt('自動複製失敗,請手動全選複製:', json); }
      ta.remove();
    }
  }
  function clearData() {
    if (confirm('清除此網站 LocalStorage 中累積的收藏資料(' + load().length + ' 筆)?')) {
      localStorage.removeItem(LS_KEY);
      updateBadge();
      setStatus('');
      alert('已清除。');
    }
  }

  /* ---------- 浮動面板 ---------- */
  function buildPanel() {
    var panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#fff', 'color:#333', 'border:1px solid #ddd',
      'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.15)',
      'padding:10px', 'font:13px/1.5 system-ui,sans-serif',
      'display:flex', 'flex-direction:column', 'gap:6px', 'width:210px',
    ].join(';');

    var title = document.createElement('div');
    title.textContent = '📥 收藏匯出 v0.3';
    title.style.cssText = 'font-weight:600;font-size:13px;padding-right:16px;';
    panel.appendChild(title);

    var badge = document.createElement('div');
    badge.id = 'xhs-tm-badge';
    badge.style.cssText = 'color:#888;font-size:12px;';
    panel.appendChild(badge);

    // 收藏夾名稱列
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var lbl = document.createElement('span');
    lbl.textContent = '收藏夾';
    lbl.style.cssText = 'font-size:12px;color:#888;flex:none;';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.id = 'xhs-tm-folder';
    inp.placeholder = '(留空=未分類)';
    inp.title = '目前打開的收藏夾名稱,掃描的筆記會帶上這個標籤';
    inp.style.cssText = 'font:inherit;font-size:12px;padding:4px 6px;border:1px solid #ccc;border-radius:6px;width:130px;';
    inp.value = detectFolderName();
    row.appendChild(lbl); row.appendChild(inp);
    panel.appendChild(row);

    var status = document.createElement('div');
    status.id = 'xhs-tm-status';
    status.style.cssText = 'color:#888;font-size:11px;min-height:14px;';
    panel.appendChild(status);

    function mkBtn(label, fn, id, muted) {
      var b = document.createElement('button');
      b.textContent = label;
      if (id) b.id = id;
      b.style.cssText = [
        'font:inherit', 'font-size:12px', 'padding:6px 10px', 'cursor:pointer',
        'border:1px solid #ccc', 'border-radius:6px',
        'background:' + (muted ? 'transparent' : '#fff'), 'color:' + (muted ? '#999' : '#333'),
      ].join(';');
      b.onclick = fn;
      panel.appendChild(b);
      return b;
    }

    mkBtn('① 掃描本頁', function () { scan(false); });
    mkBtn('▶ 自動滾動加載', toggleAutoScroll, 'xhs-tm-scrollbtn');
    mkBtn('② 複製 JSON', copyJson);
    mkBtn('清除本機資料', clearData, null, true);

    var fold = document.createElement('button');
    fold.textContent = '—';
    fold.title = '收合';
    fold.style.cssText = 'position:absolute;top:4px;right:8px;border:none;background:none;cursor:pointer;color:#999;font-size:14px;';
    fold.onclick = function () {
      var hidden = panel.dataset.folded === '1';
      panel.dataset.folded = hidden ? '0' : '1';
      Array.prototype.forEach.call(panel.children, function (c) {
        if (c !== fold && c !== title) c.style.display = hidden ? '' : 'none';
      });
      fold.textContent = hidden ? '—' : '+';
    };
    panel.appendChild(fold);

    document.body.appendChild(panel);
    updateBadge();
    console.log('[XHS匯出器] 浮動面板已建立在頁面右下角');
  }

  function updateBadge() {
    var badge = document.getElementById('xhs-tm-badge');
    if (badge) badge.textContent = (AS.running ? '⏳ ' : '') + '已累積:' + load().length + ' 筆';
  }

  /* ---------- SPA:換頁保面板、帶入收藏夾名稱、被動錯誤提示 ---------- */
  var lastKey = '';
  setInterval(function () {
    var key = location.pathname + location.search;
    if (key !== lastKey) {
      lastKey = key;
      refreshFolderInput(); // 換頁後重新帶入這個網址對應的收藏夾名稱
    }
    if (!document.getElementById('xhs-tm-badge') && document.body) buildPanel();
    if (!AS.running) {
      var badge = document.getElementById('xhs-tm-badge');
      if (badge) badge.textContent = (errorActive() ? '⚠ 頁面出錯,稍等或整理 • ' : '') + '已累積:' + load().length + ' 筆';
    }
  }, 1500);

  /* ---------- 選單指令 ---------- */
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('① 掃描本頁收藏', function () { scan(false); });
    GM_registerMenuCommand('▶/⏸ 自動滾動加載', toggleAutoScroll);
    GM_registerMenuCommand('② 複製累積 JSON', copyJson);
    GM_registerMenuCommand('清除本機累積資料', clearData);
  }

  /* ---------- 啟動 ---------- */
  function boot() {
    try { buildPanel(); }
    catch (e) { console.warn('[XHS匯出器] 建面板失敗:', e); }
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
