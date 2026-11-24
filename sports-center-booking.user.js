// ==UserScript==
// @name         運動中心預約外掛
// @namespace    local.sports.booking
// @version      0.6
// @description  選日期、場地、時段後產生預約連結，可定時搶預約；可選擇自動按「確定」完成預約；顯示目前登入帳號
// @author       Kyle, Chuang
// @match        https://bymca.xuanen.com.tw/ymca01.aspx*
// @match        https://scr.cyc.org.tw/tp25.aspx*
// @match        https://www.cjcf.com.tw/CG02.aspx*
// @match        https://bwd.xuanen.com.tw/wd27.aspx*
// @match        https://fe.xuanen.com.tw/fe01.aspx*
// @match        https://fe.xuanen.com.tw/fe03.aspx*
// @grant        none
// ==/UserScript==

// 在「網頁本身的環境」（MAIN world）執行，處理網站的 confirm() / alert() 對話框。
// 運動中心網站按下「預定場地」後，會先跳出 confirm（「您是否確定預約「場地 時段」？」），按確定才會送出預約。
// 只有在使用者勾選「自動確認預約」、且腳本剛剛點擊了某個場地的 30 秒內，才會自動回答「確定」，
// 而且訊息必須同時包含「確定預約」以及腳本選中的場地和時段，才會放行；其餘的對話框一律交給瀏覽器原本的處理。
(() => {
  'use strict';
  const AUTO = 'spAutoUntil', AUTOLOG = 'spAutoLog', ALERT = 'spLastAlert', ALERTWIN = 'spAlertUntil';
  const read = (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } };

  const origConfirm = window.confirm.bind(window);
  const origAlert = window.alert.bind(window);

  window.confirm = function (msg) {
    const text = String(msg == null ? '' : msg);
    const a = read(AUTO);
    if (a && a.until > Date.now() &&
        /確定預約/.test(text) && !/取消|刪除|退訂|退費/.test(text) &&
        text.includes(a.court) && text.includes(a.time)) {
      try {
        sessionStorage.removeItem(AUTO);                                       // 只自動確認一次
        sessionStorage.setItem(AUTOLOG, JSON.stringify({ at: Date.now(), msg: text }));
        sessionStorage.setItem(ALERTWIN, String(Date.now() + 60000));          // 接下來 60 秒內的 alert 只記錄、不跳出
      } catch (e) {}
      return true;
    }
    return origConfirm(msg);
  };

  window.alert = function (msg) {
    let until = 0;
    try { until = Number(sessionStorage.getItem(ALERTWIN)) || 0; } catch (e) {}
    if (until > Date.now()) {
      try { sessionStorage.setItem(ALERT, String(msg == null ? '' : msg)); } catch (e) {}
      return;
    }
    return origAlert(msg);
  };

  // 讓 content script 知道網站的 Cloudflare Rocket Loader 已經解除按鈕事件的封鎖
  // （在那之前，按鈕的 onclick 會直接 return false，點了沒有反應）
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (window.__cfRLUnblockHandlers || Date.now() - t0 > 4000) {
      document.documentElement.dataset.spRl = '1';
      clearInterval(iv);
    }
  }, 100);
})();

// 運動中心預約外掛 — content script（作者：Kyle, Chuang）
// 選日期、場地、時段後產生預約連結，可定時搶預約；出現確認視窗即停止，不會自動確認。
// 按「執行」前會向 background.js 查詢授權狀態。

(function () {
  'use strict';

  // ---------- 授權 ----------
  const askBg = () => Promise.resolve(null);
  const askLicense = async () => ({ ok: true });
  const licenseText = (r) => {
    if (r.ok) return `授權：已啟用${r.expText ? `（到期 ${r.expText}）` : ''}`;
    const m = { none: '尚未啟用', expired: '已過期', 'no-response': '無法連線到擴充功能', bad: '授權無效' };
    return `授權：${m[r.reason] || '授權無效'}，請到擴充功能設定頁輸入授權碼`;
  };
  let licOk = false;     // 這個頁面載入後是否已通過授權檢查
  let lastLic = null;
  const showLicense = (r) => {
    lastLic = r;
    const el = document.getElementById('sp-lic');
    if (el) el.textContent = licenseText(r);
  };

  // ---------- 資料 ----------
  const SPORTS = { 1: '羽球', 2: '籃球', 3: '桌球', 4: '撞球', 6: '網球', 8: '壁球', 13: '匹克球' };
  const slots = (a, b) => Array.from({ length: b - a }, (_, i) => {
    const f = (h) => String(h).padStart(2, '0') + ':00';
    return `${f(a + i)}~${f(a + i + 1)}`;
  });
  const PERIODS = [
    { v: 1, n: '早上', t: '06:00 ～ 12:00', slots: slots(6, 12) },
    { v: 2, n: '下午', t: '12:00 ～ 18:00', slots: slots(12, 18) },
    { v: 3, n: '晚上', t: '18:00 ～ 22:00', slots: slots(18, 22) },
  ];
  const CENTERS = [
    { name: '新生', base: 'https://bymca.xuanen.com.tw/ymca01.aspx', sports: [1, 6, 13] },
    { name: '南港', base: 'https://scr.cyc.org.tw/tp25.aspx', sports: [1, 3, 8] },
    { name: '大安', base: 'https://www.cjcf.com.tw/CG02.aspx', sports: [1, 3, 4, 8] },
    { name: '中正', base: 'https://bwd.xuanen.com.tw/wd27.aspx', sports: [1, 3] },
    { name: '三重', base: 'https://fe.xuanen.com.tw/fe01.aspx', sports: [1, 3, 8, 13] },
    { name: '土城', base: 'https://fe.xuanen.com.tw/fe03.aspx', sports: [1, 2, 3, 8, 13] },
  ];
  const RETRIES = 5;           // 定時預約：開始時間後最多重新整理幾次
  const CFG = 'spCfg', JOB = 'spJob';
  // 與 main-world.js 共用的 sessionStorage 欄位
  const AUTO = 'spAutoUntil', AUTOLOG = 'spAutoLog', ALERT = 'spLastAlert', RESULT = 'spResult', LOGK = 'spLogLines';

  const here = location.href.toLowerCase();
  const center = CENTERS.find((c) => here.startsWith(c.base.toLowerCase()));
  if (!center) return;
  const sportList = [...center.sports].sort((a, b) => a - b);

  // ---------- 狀態 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const t0 = new Date();
  const todayStr = `${t0.getFullYear()}-${pad(t0.getMonth() + 1)}-${pad(t0.getDate())}`;
  let s = { date: todayStr, sport: sportList[0], period: 3, hours: [], courts: [], startAt: '', autoConfirm: false };
  try { Object.assign(s, JSON.parse(localStorage.getItem(CFG)) || {}); } catch (e) {}
  if (!Array.isArray(s.hours)) s.hours = [];
  const periodOf = () => PERIODS.find((p) => p.v === +s.period) || PERIODS[2];
  s.hours = s.hours.filter((h) => periodOf().slots.includes(h));
  if (!sportList.includes(+s.sport)) s.sport = sportList[0];      // 該中心沒有的場地 → 改選第一個
  if (s.date < todayStr) s.date = todayStr;
  if (!Array.isArray(s.courts)) s.courts = [];
  const nowLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  // 定時預約預設填入「當下時間」；若之前存的是未來時間則保留
  if (!s.startAt || new Date(s.startAt) < new Date()) s.startAt = nowLocal();
  const saveCfg = () => localStorage.setItem(CFG, JSON.stringify(s));
  const link = (x = s) =>
    `${center.base}?module=net_booking&files=booking_place&StepFlag=2&PT=${x.sport}&D=${x.date.replace(/-/g, '/')}&D2=${x.period}`;

  // ---------- 場地清單（依所選運動類型，從預約頁自動讀取） ----------
  const COURTS = 'spCourts';
  const courtCache = () => { try { return JSON.parse(localStorage.getItem(COURTS)) || {}; } catch (e) { return {}; } };
  const ckey = (sport) => `${center.name}|${sport}`;
  let courtList = [];
  let courtState = 'loading';   // loading | ok | fail

  function parseCourts(root) {
    const out = [];
    root.querySelectorAll('table tr').forEach((tr) => {
      if (tr.querySelector('table')) return;
      const tds = [...tr.children].filter((c) => c.tagName === 'TD');
      if (tds.length < 3) return;
      const name = norm(tds[tds.length - 3].textContent);
      if (name && name.length <= 12 && !/場地名稱|時間/.test(name) && !out.includes(name)) out.push(name);
    });
    return out;
  }
  function setCourts(key, l) {
    courtList = l; courtState = 'ok';
    const c = courtCache(); c[key] = l; localStorage.setItem(COURTS, JSON.stringify(c));
    s.courts = s.courts.filter((x) => l.includes(x)); saveCfg();
    renderCourts();
  }
  async function loadCourts() {
    const key = ckey(s.sport);
    courtList = []; courtState = 'loading'; renderCourts();
    if (new URLSearchParams(location.search).get('PT') == s.sport) {      // 正好在該運動的頁面：直接讀畫面
      const l = parseCourts(document);
      if (l.length) return setCourts(key, l);
    }
    const cached = courtCache()[key];
    if (cached && cached.length) { courtList = cached; courtState = 'ok'; renderCourts(); }
    try {                                                                  // 否則向同一網站抓該頁 HTML 解析
      const r = await fetch(link(), { credentials: 'same-origin' });
      const l = parseCourts(new DOMParser().parseFromString(await r.text(), 'text/html'));
      if (l.length) return setCourts(key, l);
    } catch (e) {}
    if (!courtList.length) courtState = 'fail';
    renderCourts();
  }
  function renderCourts() {
    const el = box.querySelector('#sp-courts');
    if (!el) return;
    if (!courtList.length) {
      el.innerHTML = `<small>${courtState === 'loading' ? '讀取場地中…' : '無法自動取得場地清單，進入該運動的預約頁後會自動記住'}</small>`;
      return;
    }
    el.innerHTML = `<div class="grid3">${courtList.map((c) => {
      const i = s.courts.indexOf(c);
      return `<div class="b ${i >= 0 ? 'on' : ''}" data-court="${c}">${c}${i >= 0 ? `<small>優先 ${i + 1}</small>` : ''}</div>`;
    }).join('')}</div>`;
    el.querySelectorAll('[data-court]').forEach((b) => (b.onclick = () => {
      const c = b.dataset.court;
      s.courts = s.courts.includes(c) ? s.courts.filter((x) => x !== c) : [...s.courts, c];
      saveCfg(); renderCourts();
    }));
  }

  // ---------- 介面 ----------
  const css = document.createElement('style');
  css.textContent = `
  #sp{--bg:#fff;--fg:#222;--bd:#bbb;--mut:#777;--pri:#1a73e8;position:fixed;right:8px;bottom:8px;z-index:99999;
      width:min(94vw,340px);box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--bd);
      border-radius:10px;padding:10px;font:14px/1.4 sans-serif;box-shadow:0 2px 10px #0005}
  @media (prefers-color-scheme:dark){#sp{--bg:#1e1f22;--fg:#e8e8e8;--bd:#555;--mut:#999;--pri:#4d8dff}}
  #sp *{box-sizing:border-box}
  #sp .row{margin:6px 0}
  #sp label{display:block;font-size:12px;color:var(--mut);margin-bottom:3px}
  #sp input{width:100%;padding:6px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg)}
  #sp .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  #sp .b{padding:7px 4px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer;text-align:center}
  #sp .b.on{background:var(--pri);color:#fff;border-color:var(--pri)}
  #sp .b small{display:block;font-size:11px;opacity:.85}
  #sp .act button{padding:8px 14px;border-radius:6px;border:0;cursor:pointer;color:#fff;background:var(--pri);margin-right:6px}
  #sp .act button.stop{background:#888}
  #sp #sp-link{word-break:break-all;font-size:12px}
  #sp #sp-log{font-size:12px;color:var(--mut);white-space:pre-wrap;max-height:80px;overflow:auto}
  #sp footer{margin-top:8px;text-align:center;font-size:11px;color:#888}
  #sp-toggle{float:right;cursor:pointer;color:var(--mut)}`;
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.id = 'sp';
  document.body.appendChild(box);

  function render() {
    box.innerHTML = `
      <b>運動中心預約外掛</b><span id="sp-toggle">收合</span>
      <div id="sp-body">
        <div class="row"><label>運動中心</label><b>${center.name}</b></div>
        <div class="row"><label>登入帳號</label><b id="sp-user"></b></div>
        <div class="row"><label>日期</label><input type="date" id="sp-date" min="${todayStr}" value="${s.date}"></div>
        <div class="row"><label>場地</label><div class="grid3">
          ${sportList.map((v) => `<div class="b ${+s.sport === v ? 'on' : ''}" data-sport="${v}">${SPORTS[v]}</div>`).join('')}
        </div></div>
        <div class="row"><label>場地選擇（可複選，依點選順序優先；優先場地約不到才改約其它任一場地；都不選＝任一場地）</label><div id="sp-courts"></div></div>
        <div class="row"><label>時段</label><div class="grid3">
          ${PERIODS.map((p) => `<div class="b ${+s.period === p.v ? 'on' : ''}" data-period="${p.v}">${p.n}<small>${p.t}</small></div>`).join('')}
        </div></div>
        <div class="row"><label>時間（可複選；都不選＝時段內最早可預約）</label><div class="grid3">
          ${periodOf().slots.map((h) => `<div class="b ${s.hours.includes(h) ? 'on' : ''}" data-hour="${h}">${h}</div>`).join('')}
        </div></div>
        <div class="row"><label>定時預約（預設＝現在，按執行立即開始；改成未來時間則到點自動執行）</label>
          <input type="datetime-local" id="sp-start" step="1" value="${s.startAt}"></div>
        <div class="row"><label style="display:flex;gap:6px;align-items:flex-start;color:var(--fg);font-size:13px">
          <input type="checkbox" id="sp-auto" ${s.autoConfirm ? 'checked' : ''} style="width:auto;margin-top:3px">
          <span>自動確認預約：出現「您是否確定預約」時自動按「確定」，直接完成預約<br>
          <small style="color:var(--mut)">按下後即成立預約，請留意場館的費用與取消規定。不勾選則由你自己按確定。</small></span></label></div>
        <div class="row"><label>預約連結</label><a id="sp-link" href="${link()}">${link()}</a></div>
        <div class="row act"><button id="sp-run">執行</button><button class="stop" id="sp-stop">停止</button></div>
        <div id="sp-log"></div>
        <footer>作者：Kyle, Chuang</footer>
      </div>`;
    const q = (id) => box.querySelector(id);
    q('#sp-toggle').onclick = () => {
      const b = q('#sp-body'); b.style.display = b.style.display === 'none' ? '' : 'none';
    };
    q('#sp-date').onchange = (e) => { s.date = e.target.value || todayStr; saveCfg(); render(); };
    box.querySelectorAll('[data-sport]').forEach((el) => (el.onclick = () => { s.sport = +el.dataset.sport; s.courts = []; saveCfg(); render(); loadCourts(); }));
    box.querySelectorAll('[data-period]').forEach((el) => (el.onclick = () => { s.period = +el.dataset.period; s.hours = []; saveCfg(); render(); }));
    box.querySelectorAll('[data-hour]').forEach((el) => (el.onclick = () => {
      const h = el.dataset.hour;
      s.hours = s.hours.includes(h) ? s.hours.filter((x) => x !== h) : [...s.hours, h];
      saveCfg(); render();
    }));
    q('#sp-start').onchange = (e) => { s.startAt = e.target.value; saveCfg(); };
    q('#sp-auto').onchange = (e) => {
      if (e.target.checked && !confirm('開啟「自動確認預約」後，腳本找到可預約的場地就會直接按下確定並成立預約。\n請確認你了解場館的費用與取消規定。\n\n要開啟嗎？')) {
        e.target.checked = false; return;
      }
      s.autoConfirm = e.target.checked; saveCfg();
    };
    renderCourts();
    renderLog();
    showUser();
    q('#sp-run').onclick = startJob;
    q('#sp-stop').onclick = () => { sessionStorage.removeItem(JOB); status('已停止'); };
  }
  // 訊息記錄存在 sessionStorage，頁面跳轉後仍看得到結果
  const readLog = () => { try { return JSON.parse(sessionStorage.getItem(LOGK)) || []; } catch (e) { return []; } };
  function renderLog() {
    const l = box.querySelector('#sp-log');
    if (l) l.textContent = readLog().join('\n');
  }
  function status(m) {
    const lines = [`${new Date().toLocaleTimeString()} ${m}`, ...readLog()].slice(0, 12);
    try { sessionStorage.setItem(LOGK, JSON.stringify(lines)); } catch (e) {}
    renderLog();
  }

  // ---------- 搶預約 ----------
  const norm = (t) => t.replace(/\s/g, '').replace(/～/g, '~');

  // 目前登入的使用者名稱：網站頁首會顯示「○○○ 您好」（姓名通常已被網站遮蔽部分字元）
  function getUserName() {
    const text = (document.body ? document.body.innerText : '').slice(0, 600);
    const m = text.match(/([^\s|｜]{1,20})\s*您好/);
    return m ? m[1] : '';
  }
  function showUser() {
    const el = box.querySelector('#sp-user');
    if (!el) return;
    const name = getUserName();
    el.textContent = name || '未偵測到（可能尚未登入）';
    el.style.color = name ? '' : 'var(--bad, #c62828)';
  }

  // 回傳目前頁面所有可預約的格子，順序＝時間由早到晚、場地由上到下
  function candidates(hours, courts) {
    const out = [];
    let curTime = '';
    for (const tr of document.querySelectorAll('table tr')) {
      if (tr.querySelector('table')) continue;
      const tds = [...tr.children];
      if (tds.length < 3) continue;
      if (tds.length >= 4) curTime = norm(tds[0].innerText);
      const court = norm(tds[tds.length - 3].innerText);
      const act = tds[tds.length - 1];
      if (!court || /已被預約|已預約|額滿|已滿/.test(act.innerHTML + act.innerText)) continue;
      const el = act.querySelector('a,input,button,img');
      if (!el) continue;
      if (hours && hours.length && !hours.some((h) => curTime.startsWith(h.split('~')[0]))) continue;
      const i = courts ? courts.indexOf(court) : -1;
      out.push({ time: curTime, court, el, rank: i < 0 ? 999 : i });
    }
    // 優先場地（依點選順序）排前面，其餘維持「時間早→晚、場地由上到下」
    return out.sort((a, b) => a.rank - b.rank);
  }

  function realClick(el) {
    const t = el.closest('a,button') || el;
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) =>
      t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 等網站準備好：Rocket Loader 已解除按鈕封鎖，且 Cloudflare 驗證產生的 captchaToken 已就緒。
  // 這裡只是「等」瀏覽器自己通過驗證，不會繞過或代為完成驗證。
  async function waitReady(maxMs = 15000) {
    const t0 = Date.now();
    const hasTurnstile = () => !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
    while (Date.now() - t0 < maxMs) {
      const rl = document.documentElement.dataset.spRl === '1';
      const cookie = document.cookie.includes('captchaToken=');
      if (rl && (cookie || (!hasTurnstile() && Date.now() - t0 > 3000))) return true;
      await sleep(200);
    }
    return false;
  }

  // 自動模式：點「預定場地」→ main-world.js 對網站的確認視窗自動回答「確定」（只放行這一個場地、只放行一次）
  async function autoBook(pick, tag) {
    status(`找到：${pick.time} ${pick.court}${tag}，等待網站驗證…`);
    if (!(await waitReady())) {
      status('網站驗證（Cloudflare）尚未通過，已停止；請手動完成預約');
      return;
    }
    sessionStorage.removeItem(AUTOLOG);
    sessionStorage.removeItem(ALERT);
    sessionStorage.setItem(AUTO, JSON.stringify({ until: Date.now() + 30000, court: pick.court, time: pick.time }));
    sessionStorage.setItem(RESULT, JSON.stringify({ at: Date.now(), time: pick.time, court: pick.court, user: getUserName(), reported: false }));
    for (let attempt = 1; attempt <= 2 && !sessionStorage.getItem(AUTOLOG); attempt++) {
      status(`自動確認：${pick.time} ${pick.court}${tag}（帳號：${getUserName() || '未知'}）`);
      realClick(pick.el);
      for (let i = 0; i < 10 && !sessionStorage.getItem(AUTOLOG); i++) await sleep(200);
    }
    if (!sessionStorage.getItem(AUTOLOG)) {
      sessionStorage.removeItem(AUTO);
      status('點擊沒有觸發確認視窗，已停止；請手動按「預定場地」');
      return;
    }
    status('已自動按下「確定」，等待網站回應…');
    await sleep(5000);          // 頁面若有跳轉，這個腳本會被中止，由新頁面的 checkResult 回報；沒跳轉就在這裡回報
    await checkResult();
  }

  // 判斷預約結果並回報（只回報一次；不會再點任何按鈕，也不會輸入付款資料）
  async function checkResult() {
    let r = null;
    try { r = JSON.parse(sessionStorage.getItem(RESULT)); } catch (e) {}
    if (!r || r.reported || Date.now() - r.at > 180000 || !sessionStorage.getItem(AUTOLOG)) return;
    await sleep(1200);
    r.reported = true;
    sessionStorage.setItem(RESULT, JSON.stringify(r));
    const alertTxt = sessionStorage.getItem(ALERT) || '';
    const text = (document.body ? document.body.innerText : '') + '\n' + alertTxt;
    if (alertTxt) status(`網站訊息：${alertTxt}`);
    const who = r.user ? `（帳號：${r.user}）` : '';
    if (/預約成功|預約完成|已完成預約|訂位成功/.test(text)) status(`✔ 預約成功：${r.time} ${r.court}${who}`);
    else if (/失敗|無法預約|已被預約|額滿|錯誤/.test(alertTxt)) status(`✖ 預約可能失敗：${r.time} ${r.court}${who}，請到會員的預約紀錄確認`);
    else if (/信用卡|卡號|付款|繳費|轉帳/.test(text)) status('頁面出現付款相關內容，請自行確認或完成付款（腳本不會輸入付款資料）');
    else status(`已自動按下確定（${r.time} ${r.court}${who}），請查看頁面或預約紀錄確認結果`);
  }

  async function startJob() {
    const lic = await askLicense();
    showLicense(lic);
    if (!lic.ok) {
      status('尚未取得有效授權，無法執行');
      askBg({ type: 'open-options' });
      return;
    }
    licOk = true;
    const user = getUserName();
    showUser();
    const future = s.startAt && new Date(s.startAt).getTime() > Date.now();   // 過去或現在 → 立即執行
    sessionStorage.setItem(JOB, JSON.stringify({ ...s, user, startAt: future ? s.startAt : '', tries: 0, done: false }));
    status(user ? `開始執行（登入帳號：${user}）` : '開始執行（未偵測到登入帳號，可能尚未登入）');
    step();
  }

  async function step() {
    let j = null;
    try { j = JSON.parse(sessionStorage.getItem(JOB)); } catch (e) {}
    if (!j || j.done) return;
    if (!licOk) {                                  // 頁面重新載入後續跑前，再確認一次授權
      const lic = await askLicense();
      showLicense(lic);
      if (!lic.ok) { sessionStorage.removeItem(JOB); status('授權無效，已停止'); return; }
      licOk = true;
    }
    const put = () => sessionStorage.setItem(JOB, JSON.stringify(j));
    const nowUser = getUserName();
    if (j.user && nowUser && nowUser !== j.user) {        // 中途登入了別的帳號 → 停止，避免用錯帳號預約
      sessionStorage.removeItem(JOB);
      status(`登入帳號已從「${j.user}」變成「${nowUser}」，已停止`);
      return;
    }
    const startMs = j.startAt ? new Date(j.startAt).getTime() : 0;

    if (startMs && Date.now() < startMs) {
      status(`等待開始時間 ${j.startAt.replace('T', ' ')}`);
      return setTimeout(step, 250);
    }
    // 1. 確認在目標頁
    const p = new URLSearchParams(location.search);
    const onTarget = p.get('StepFlag') === '2' && p.get('PT') == j.sport &&
      p.get('D') === j.date.replace(/-/g, '/') && p.get('D2') == j.period;
    if (!onTarget) { location.href = link(j); return; }
    // 2. 定時：確保資料是開始時間之後才載入的
    if (startMs && performance.timeOrigin < startMs) { location.reload(); return; }

    // 3. 找可預約的格子，第一個就是「最早時間、最前面的場地」；被占走自然會改選下一個
    const c = candidates(j.hours, j.courts);
    if (c.length) {
      j.done = true; put();
      const pick = c[0];
      const tag = j.courts && j.courts.length ? (pick.rank < 999 ? '（優先場地）' : '（優先場地已無，改約其它場地）') : '';
      if (!j.autoConfirm) {
        status(`點擊：${pick.time} ${pick.court}${tag}。請在確認視窗自行確認`);
        realClick(pick.el);                     // 手動模式：只點一次，確認視窗由你自己按
        return;
      }
      await autoBook(pick, tag);                // 自動模式：點擊後自動按「確定」
      return;
    }
    if (startMs && j.tries < RETRIES) {
      j.tries++; put();
      status(`尚無可預約場地，重新整理（${j.tries}/${RETRIES}）`);
      return setTimeout(() => location.reload(), 1000);
    }
    j.done = true; put();
    status('沒有任何可預約的場地，已停止');
  }

  render();
  loadCourts();
  askLicense().then(showLicense);
  setTimeout(checkResult, 800);   // 自動確認後頁面若已跳轉，在新頁面回報結果
  setTimeout(step, 500);   // 頁面重新整理或跳轉後，續跑未完成的工作
})();
