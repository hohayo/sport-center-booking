// 背景程式（service worker）：負責授權的啟用、驗證與續期。
import { CONFIG } from './config.js';
import { verifyToken } from './lib/license.js';

const DAY = 86400000;
const REFRESH_BEFORE = 2 * DAY;                         // 憑證剩 2 天內就在背景續期
const FATAL = ['invalid_key', 'revoked', 'expired'];     // 伺服器明確拒絕 → 清掉本機憑證

const getLocal = (keys) => chrome.storage.local.get(keys);
const fmt = (ms) => new Date(ms).toLocaleDateString('zh-TW');

async function deviceId() {
  const { deviceId: id } = await getLocal('deviceId');
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

// 檢查本機已存的憑證（不連網）
async function checkStored() {
  const { token, devToken } = await getLocal(['token', 'devToken']);
  if (CONFIG.DEV_MODE && devToken && devToken.exp > Date.now()) {
    return { ok: true, dev: true, exp: devToken.exp, expText: fmt(devToken.exp) };
  }
  if (!token) return { ok: false, reason: 'none' };
  if (!CONFIG.PUBLIC_KEY_JWK) return { ok: false, reason: 'bad' };
  const r = await verifyToken(token, CONFIG.PUBLIC_KEY_JWK, await deviceId());
  return r.ok
    ? { ok: true, exp: r.payload.exp, expText: fmt(r.payload.exp) }
    : { ok: false, reason: r.reason };
}

// 向伺服器啟用／續期
async function callServer(action, key) {
  const device = await deviceId();
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, key, deviceId: device }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    if (FATAL.includes(data.error)) await chrome.storage.local.remove(['token', 'licenseKey']);
    return { ok: false, error: data.error || 'server-error' };
  }
  const r = await verifyToken(data.token, CONFIG.PUBLIC_KEY_JWK, device);
  if (!r.ok) return { ok: false, error: 'bad-token' };
  await chrome.storage.local.set({ token: data.token, licenseKey: key });
  return { ok: true, exp: r.payload.exp, expText: fmt(r.payload.exp) };
}

async function activate(key) {
  key = String(key || '').trim();
  if (!key) return { ok: false, error: 'empty' };
  if (CONFIG.DEV_MODE && key === CONFIG.DEV_KEY) {
    const devToken = { exp: Date.now() + 7 * DAY };
    await chrome.storage.local.set({ devToken });
    return { ok: true, dev: true, exp: devToken.exp, expText: fmt(devToken.exp) };
  }
  if (!CONFIG.API_URL || !CONFIG.PUBLIC_KEY_JWK) return { ok: false, error: 'not-configured' };
  try { return await callServer('activate', key); } catch (e) { return { ok: false, error: 'network' }; }
}

async function refresh() {
  const { licenseKey } = await getLocal('licenseKey');
  if (!licenseKey || !CONFIG.API_URL || !CONFIG.PUBLIC_KEY_JWK) return null;
  try { return await callServer('refresh', licenseKey); } catch (e) { return null; }
}

async function status() {
  const s = await checkStored();
  if (s.ok) {
    if (!s.dev && s.exp - Date.now() < REFRESH_BEFORE) refresh();          // 背景續期，不等結果
    return s;
  }
  if (s.reason === 'expired') {                                             // 憑證過期 → 嘗試向伺服器續期
    const r = await refresh();
    if (r && r.ok) return r;
  }
  return s;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 啟用、清除、查裝置 ID 只允許擴充功能自己的頁面（設定頁）呼叫
  const fromExtensionPage = (sender.url || '').startsWith(chrome.runtime.getURL(''));
  (async () => {
    switch (msg && msg.type) {
      case 'license-status': return sendResponse(await status());
      case 'open-options': chrome.runtime.openOptionsPage(); return sendResponse({ ok: true });
      case 'license-activate':
        return sendResponse(fromExtensionPage ? await activate(msg.key) : { ok: false, error: 'forbidden' });
      case 'license-clear':
        if (!fromExtensionPage) return sendResponse({ ok: false });
        await chrome.storage.local.remove(['token', 'licenseKey', 'devToken']);
        return sendResponse({ ok: true });
      case 'device-id':
        return sendResponse(fromExtensionPage ? { deviceId: await deviceId() } : {});
      default: return sendResponse(null);
    }
  })();
  return true;     // 非同步回應
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
