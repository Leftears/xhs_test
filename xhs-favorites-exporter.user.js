// ==UserScript==
// @name         小紅書收藏匯出器 (XHS Favorites Exporter)
// @namespace    xhs-local-tools
// @version      0.2.1
// @description  在小紅書收藏頁讀取已載入的收藏卡片,存入 LocalStorage,並可一鍵複製 JSON 貼到「收藏管理台」。
// @author       you
// @match        *://*.xiaohongshu.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* ============================================================
  使用方式
  ------------------------------------------------------------
  1. 安裝 Tampermonkey,新增腳本,貼上本檔內容並儲存。
  2. 打開小紅書網頁版 → 個人主頁 → 收藏 (collect) 分頁。
  3. 往下滾動加載你想匯出的收藏 (腳本只讀「已載入」的 DOM,
     不發任何請求,避免觸發反爬)。
  4. 點畫面右下角的「📥 收藏匯出」浮動按鈕:
     - 「掃描本頁」:把目前 DOM 上的收藏卡片寫入 LocalStorage
     - 「複製 JSON」:把累積的資料複製到剪貼簿
  也可用 Tampermonkey 選單裡的指令,效果相同。

  輸出格式 (貼到 xhs-favorites-manager.html 即可):
  { "source": "xhs-tampermonkey", "items": [ { id, title, url, cover, author, noteType } ] }

  注意:
  - 小紅書前端 DOM 的 class 名是編譯產物 (形如 css-1abc...),
    這裡用「屬性選擇器 + 結構備援」抓卡片, 版面更新時可能需調整。
  - 封面圖使用 no-referrer 載入,離開小紅書網站後可能載不出來屬正常
    (防盜鏈),管理台會顯示「無封面」。
============================================================ */

(function () {
  'use strict';

  // 診斷訊息:開 F12 Console 看到這行 = 腳本有被注入;沒看到 = 腳本根本沒執行
  console.log('[XHS匯出器] v0.2.1 已載入 →', location.href);

  var LS_KEY = 'xhs_tm_favorites';
  var MAX_STORE = 5000; // LocalStorage 上限保護

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

  /* ---------- 抓取目前 DOM 上的收藏卡片 ---------- */
  // 小紅書卡片的連結一律指向 /explore/{id} 或 /discovery/item/{id} 或 /search_result/{id}
  var NOTE_LINK = /^\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{16,})/;

  function scan() {
    var found = {};
    // 備援 1:任何指向筆記的 <a>
    document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]').forEach(function (a) {
      var m = (a.getAttribute('href') || '').match(NOTE_LINK);
      if (!m) return;
      var id = m[1];
      if (found[id]) return;

      // 標題:卡片內的 .title / [class*="title"],否則用 a 的 title 屬性,再不然 alt
      var root = a.closest('section, li, div[class]') || a;
      var titleEl =
        root.querySelector('[class*="title"]') ||
        root.querySelector('.title') ||
        a.querySelector('[class*="title"]');
      var title = (titleEl && titleEl.textContent.trim()) ||
                  a.getAttribute('title') || '';

      // 封面:卡片內第一張 img (取 src 或 srcset 第一個)
      var img = root.querySelector('img') || a.querySelector('img');
      var cover = '';
      if (img) {
        cover = img.currentSrc || img.src || '';
        if (!cover && img.srcset) cover = img.srcset.split(',')[0].trim().split(' ')[0];
      }

      // 作者:卡片 hover 才出現的 .author / [class*="author"];抓不到就空
      var authorEl = root.querySelector('[class*="author"], .author, .name');
      var author = authorEl ? authorEl.textContent.trim() : '';

      // 影片判定:卡片上常有播放圖示或 .play
      var isVideo = !!root.querySelector('[class*="play"], .play-icon, [class*="video"]');

      found[id] = {
        id: id,
        title: title || '(無標題)',
        url: 'https://www.xiaohongshu.com/explore/' + id,
        cover: cover,
        author: author,
        noteType: isVideo ? 'video' : 'normal',
        scannedAt: new Date().toISOString(),
      };
    });

    // 備援 2:結構抓不到時,試 __INITIAL_STATE__ (小紅書 SSR 注入的全域狀態)
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
              scannedAt: new Date().toISOString(),
            };
          });
        }
      } catch (e) { /* 忽略,結構變了 */ }
    }

    // 合併進 LocalStorage (以 id 去重)
    var list = load();
    var map = {};
    list.forEach(function (it) { map[it.id] = it; });
    var added = 0;
    Object.keys(found).forEach(function (id) {
      if (!map[id]) { map[id] = found[id]; added++; }
    });
    var merged = Object.keys(map).map(function (k) { return map[k]; });
    save(merged);

    var msg = '本頁掃描到 ' + Object.keys(found).length + ' 張卡片,新增加入 ' + added +
              ' 筆,目前累積 ' + merged.length + ' 筆。\n\n' +
              '提示:往下滾動加載更多後再按一次「掃描本頁」即可累積。';
    alert(msg);
    updateBadge();
    return merged;
  }

  /* ---------- 匯出 / 複製 ---------- */
  function buildJson() {
    var list = load().map(function (it) {
      return {
        id: it.id, title: it.title, url: it.url, cover: it.cover,
        author: it.author, noteType: it.noteType,
      };
    });
    return JSON.stringify({ source: 'xhs-tampermonkey', count: list.length, items: list }, null, 2);
  }

  function copyJson() {
    var list = load();
    if (!list.length) { alert('還沒有資料,先按「掃描本頁」。'); return; }
    var json = buildJson();
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(json, 'text');
      alert('已複製 ' + list.length + ' 筆到剪貼簿!\n打開 xhs-favorites-manager.html 貼到「資料匯入」即可。');
    } else {
      // fallback: 開個 textarea 用 execCommand
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
      alert('已清除。');
    }
  }

  /* ---------- 浮動面板 ---------- */
  var panel = null;

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#fff', 'color:#333', 'border:1px solid #ddd',
      'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.15)',
      'padding:10px', 'font:13px/1.5 system-ui,sans-serif',
      'display:flex', 'flex-direction:column', 'gap:6px', 'min-width:150px',
    ].join(';');

    var title = document.createElement('div');
    title.textContent = '📥 收藏匯出';
    title.style.cssText = 'font-weight:600;font-size:13px;';
    panel.appendChild(title);

    var badge = document.createElement('div');
    badge.id = 'xhs-tm-badge';
    badge.style.cssText = 'color:#888;font-size:12px;';
    panel.appendChild(badge);

    function mkBtn(label, fn) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'font:inherit', 'padding:6px 10px', 'cursor:pointer',
        'border:1px solid #ccc', 'border-radius:6px', 'background:#fff',
      ].join(';');
      b.onclick = fn;
      panel.appendChild(b);
      return b;
    }

    mkBtn('① 掃描本頁', scan);
    mkBtn('② 複製 JSON', copyJson);
    mkBtn('清除本機資料', clearData);

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
    if (badge) badge.textContent = '已累積:' + load().length + ' 筆';
  }

  /* ---------- SPA:換頁後確保面板還在 ---------- */
  var lastPath = '';
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
    }
    if (!document.getElementById('xhs-tm-badge') && document.body) {
      buildPanel();
    }
  }, 1500);

  /* ---------- 啟動:body 可能晚於 document-idle 才有,用雙保險 ---------- */
  function boot() {
    try { buildPanel(); }
    catch (e) { console.warn('[XHS匯出器] 建面板失敗:', e); }
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
  // 極端情況:body 被 SPA 重建,定時器會再救一次(見上方 setInterval)

  /* ---------- 選單指令 (Tampermonkey 圖示選單) ---------- */
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('① 掃描本頁收藏', scan);
    GM_registerMenuCommand('② 複製累積 JSON', copyJson);
    GM_registerMenuCommand('清除本機累積資料', clearData);
  }
})();
