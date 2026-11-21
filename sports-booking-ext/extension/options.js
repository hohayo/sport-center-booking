import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);
const send = (m) => new Promise((resolve) => chrome.runtime.sendMessage(m, (r) => resolve(chrome.runtime.lastError ? null : r)));

const ERR = {
  empty: '請輸入授權碼',
  forbidden: '操作被拒絕',
  network: '無法連線到授權伺服器，請檢查網路後再試',
  'not-configured': '尚未設定授權伺服器或公鑰（請看 README 的「正式上線前檢查」）',
  invalid_key: '授權碼不存在，請確認有沒有輸入錯誤',
  revoked: '這組授權碼已被停用',
  expired: '這組授權碼已過期',
  device_limit: '這組授權碼已達裝置數量上限',
  'bad-token': '伺服器回傳的憑證驗證失敗',
  'server-error': '伺服器發生錯誤，請稍後再試',
};
const REASON = { none: '尚未啟用', expired: '授權已過期', bad: '授權無效' };

async function showStatus() {
  const st = await send({ type: 'license-status' });
  const el = $('state');
  if (st && st.ok) {
    el.className = 'ok';
    el.textContent = `✔ 已啟用${st.dev ? '（測試模式）' : ''}，到期日：${st.expText}`;
  } else {
    el.className = 'bad';
    el.textContent = `✖ ${REASON[(st && st.reason) || 'none'] || '尚未啟用'}`;
  }
}

$('activate').onclick = async () => {
  $('msg').textContent = '啟用中…';
  const r = await send({ type: 'license-activate', key: $('key').value });
  $('msg').textContent = r && r.ok ? '啟用成功' : (ERR[r && r.error] || '啟用失敗');
  if (r && r.ok) $('key').value = '';
  showStatus();
};
$('clear').onclick = async () => {
  await send({ type: 'license-clear' });
  $('msg').textContent = '已移除授權';
  showStatus();
};

if (CONFIG.DEV_MODE) { $('devbox').hidden = false; $('devkey').textContent = CONFIG.DEV_KEY; }
send({ type: 'device-id' }).then((r) => { $('device').textContent = (r && r.deviceId) || ''; });
showStatus();
