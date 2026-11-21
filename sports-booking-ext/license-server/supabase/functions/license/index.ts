// 授權伺服器（Supabase 邊緣函式）
// 部署：supabase functions deploy license --no-verify-jwt
// 需要的 secret：LICENSE_PRIVATE_JWK（gen-keys.mjs 產生的私鑰 JSON，只放在這裡，絕對不要放進擴充程式）
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TOKEN_DAYS = 7;   // 每張憑證有效天數；擴充程式會在剩 2 天內自動續期

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// 憑證格式需與 extension/lib/license.js 一致：b64u(payload) + '.' + b64u(簽章)
async function sign(payload: Record<string, unknown>) {
  const jwk = JSON.parse(Deno.env.get('LICENSE_PRIVATE_JWK')!);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const p = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(p));
  return `${p}.${b64u(sig)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let body: { key?: unknown; deviceId?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad-request' }, 400); }
  const key = String(body.key ?? '').trim();
  const device = String(body.deviceId ?? '').trim();
  if (!key || !device || key.length > 100 || device.length > 100) return json({ error: 'bad-request' }, 400);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: lic } = await db.from('licenses').select('*').eq('key', key).maybeSingle();
  if (!lic) return json({ error: 'invalid_key' }, 403);
  if (lic.revoked) return json({ error: 'revoked' }, 403);
  const expiresAt = new Date(lic.expires_at).getTime();
  if (expiresAt <= Date.now()) return json({ error: 'expired' }, 403);

  // 裝置數量限制：同一裝置可重複啟用／續期，新裝置超過上限就拒絕
  const { data: acts } = await db.from('activations').select('device_id').eq('key', key);
  const known = (acts ?? []).some((a) => a.device_id === device);
  if (!known && (acts?.length ?? 0) >= lic.max_devices) return json({ error: 'device_limit' }, 403);
  await db.from('activations').upsert(
    { key, device_id: device, last_seen: new Date().toISOString() },
    { onConflict: 'key,device_id' },
  );

  const exp = Math.min(expiresAt, Date.now() + TOKEN_DAYS * 86400000);
  const token = await sign({ v: 1, device, exp, plan: lic.note ?? null });
  return json({ token });
});
