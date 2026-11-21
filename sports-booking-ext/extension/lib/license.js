// 授權憑證驗證（ECDSA P-256 / SHA-256）
// 憑證格式：base64url(JSON payload) + '.' + base64url(簽章，IEEE-P1363 共 64 bytes)
// 簽章對象是「payload 的 base64url 字串」本身。伺服器用私鑰簽，這裡只用公鑰驗。

export function b64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 驗證憑證。回傳 { ok, reason?, payload? }
 * reason：'bad'（簽章錯誤／格式錯誤／裝置不符）| 'expired'
 */
export async function verifyToken(token, publicJwk, deviceId, now = Date.now()) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'bad' };
    const [p, sig] = parts;
    const key = await crypto.subtle.importKey(
      'jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, b64uToBytes(sig), new TextEncoder().encode(p));
    if (!valid) return { ok: false, reason: 'bad' };
    const payload = JSON.parse(new TextDecoder().decode(b64uToBytes(p)));
    if (payload.device !== deviceId) return { ok: false, reason: 'bad' };
    if (!(payload.exp > now)) return { ok: false, reason: 'expired', payload };
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: 'bad' };
  }
}
