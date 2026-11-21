// 授權管理 API（Supabase 邊緣函式）— 給 admin.html 使用
// 部署：supabase functions deploy admin --no-verify-jwt   （登入驗證由本函式自己做）
// 需要的 secret：ADMIN_EMAILS（可管理的信箱，逗號分隔，例如 hohayo@gmail.com）
//
// 安全做法：
//   1. 管理頁面用 Supabase Auth 登入，帶著使用者的 access token 呼叫這裡。
//   2. 這裡向 Supabase Auth 驗證 token，並確認信箱在 ADMIN_EMAILS 白名單內、且已通過信箱驗證。
//   3. 通過後才用 service role 操作資料庫。service role key 只存在伺服器，不會出現在網頁。
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admins = () =>
  (Deno.env.get('ADMIN_EMAILS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const randKey = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');   // 32 碼隨機十六進位
};

// 整數檢查：不合法回傳 null
const int = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const keyOf = (v: unknown) => {
  const k = String(v ?? '').trim();
  return k && k.length <= 100 ? k : null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  // ---- 1. 驗證身分 ----
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!);
  const { data, error: authErr } = await anon.auth.getUser(auth.slice(7));
  const user = data?.user;
  if (authErr || !user?.email) return json({ error: 'unauthorized' }, 401);
  if (!user.email_confirmed_at || !admins().includes(user.email.toLowerCase())) {
    return json({ error: 'forbidden' }, 403);
  }

  // ---- 2. 執行動作 ----
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad-request' }, 400); }
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const fail = (e: unknown) => { console.error(e); return json({ error: 'db' }, 500); };

  switch (body.action) {
    case 'list': {
      const a = await db.from('licenses').select('*').order('created_at', { ascending: false });
      const b = await db.from('activations').select('key,device_id,first_seen,last_seen');
      if (a.error || b.error) return fail(a.error || b.error);
      const by: Record<string, unknown[]> = {};
      (b.data ?? []).forEach((r) => { (by[r.key] ||= []).push({ device_id: r.device_id, first_seen: r.first_seen, last_seen: r.last_seen }); });
      return json({ licenses: (a.data ?? []).map((l) => ({ ...l, devices: by[l.key] ?? [] })) });
    }

    case 'create': {
      const days = int(body.days, 1, 3650);
      const max = int(body.max_devices, 1, 50);
      const count = int(body.count ?? 1, 1, 20);
      if (days === null || max === null || count === null) return json({ error: 'bad-request' }, 400);
      const note = String(body.note ?? '').trim().slice(0, 100) || null;
      const expires = new Date(Date.now() + days * 86400000).toISOString();
      const rows = Array.from({ length: count }, () => ({ key: randKey(), expires_at: expires, max_devices: max, note }));
      const { error } = await db.from('licenses').insert(rows);
      if (error) return fail(error);
      return json({ keys: rows.map((r) => r.key) });
    }

    case 'set_revoked': {
      const key = keyOf(body.key);
      if (!key || typeof body.revoked !== 'boolean') return json({ error: 'bad-request' }, 400);
      const { error } = await db.from('licenses').update({ revoked: body.revoked }).eq('key', key);
      return error ? fail(error) : json({ ok: true });
    }

    case 'extend': {
      const key = keyOf(body.key);
      const days = int(body.days, 1, 3650);
      if (!key || days === null) return json({ error: 'bad-request' }, 400);
      const { data: lic, error: e1 } = await db.from('licenses').select('expires_at').eq('key', key).maybeSingle();
      if (e1) return fail(e1);
      if (!lic) return json({ error: 'not-found' }, 404);
      const base = Math.max(Date.now(), new Date(lic.expires_at).getTime());   // 已過期的從現在起算
      const { error } = await db.from('licenses')
        .update({ expires_at: new Date(base + days * 86400000).toISOString() }).eq('key', key);
      return error ? fail(error) : json({ ok: true });
    }

    case 'update': {
      const key = keyOf(body.key);
      if (!key) return json({ error: 'bad-request' }, 400);
      const patch: Record<string, unknown> = {};
      if (body.max_devices !== undefined) {
        const m = int(body.max_devices, 1, 50);
        if (m === null) return json({ error: 'bad-request' }, 400);
        patch.max_devices = m;
      }
      if (body.note !== undefined) patch.note = String(body.note).trim().slice(0, 100) || null;
      if (!Object.keys(patch).length) return json({ error: 'bad-request' }, 400);
      const { error } = await db.from('licenses').update(patch).eq('key', key);
      return error ? fail(error) : json({ ok: true });
    }

    case 'reset_devices': {
      const key = keyOf(body.key);
      if (!key) return json({ error: 'bad-request' }, 400);
      const { error } = await db.from('activations').delete().eq('key', key);
      return error ? fail(error) : json({ ok: true });
    }

    case 'remove_device': {
      const key = keyOf(body.key);
      const device = keyOf(body.device_id);
      if (!key || !device) return json({ error: 'bad-request' }, 400);
      const { error } = await db.from('activations').delete().eq('key', key).eq('device_id', device);
      return error ? fail(error) : json({ ok: true });
    }

    case 'delete': {
      const key = keyOf(body.key);
      if (!key) return json({ error: 'bad-request' }, 400);
      const { error } = await db.from('licenses').delete().eq('key', key);   // activations 會連動刪除
      return error ? fail(error) : json({ ok: true });
    }

    default:
      return json({ error: 'unknown-action' }, 400);
  }
});
