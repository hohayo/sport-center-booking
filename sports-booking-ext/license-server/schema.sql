-- 授權碼資料表（在 Supabase 的 SQL Editor 執行）

create table if not exists licenses (
  key         text primary key,                 -- 授權碼（請用夠長的隨機字串）
  expires_at  timestamptz not null,             -- 到期時間
  max_devices int not null default 2,           -- 最多可啟用幾台裝置
  revoked     boolean not null default false,   -- 設成 true 即停用（最多 2 天內生效）
  note        text,                             -- 備註（例如買家名稱）
  created_at  timestamptz not null default now()
);

create table if not exists activations (
  key        text not null references licenses(key) on delete cascade,
  device_id  text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (key, device_id)
);

-- 開啟 RLS 且不建立任何 policy：只有邊緣函式（service role）能讀寫，前端無法直接存取
alter table licenses    enable row level security;
alter table activations enable row level security;

-- ===== 發出一組授權碼（30 天、最多 2 台裝置）=====
-- insert into licenses (key, expires_at, max_devices, note)
-- values (replace(gen_random_uuid()::text, '-', ''), now() + interval '30 days', 2, '朋友A')
-- returning key;

-- ===== 停用一組授權碼 =====
-- update licenses set revoked = true where key = '要停用的授權碼';

-- ===== 重設某組授權碼的裝置（換電腦時）=====
-- delete from activations where key = '授權碼';
