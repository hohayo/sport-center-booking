// 設定檔 — 上架或發給別人之前，請依 README 的「正式上線前檢查」逐項確認。
export const CONFIG = {
  // ⚠ 測試用：true 時，輸入 DEV_KEY 就能在本機啟用（不需要伺服器）。
  //   上架或發給別人之前務必改成 false，否則任何人都能用這組碼。
  DEV_MODE: true,
  DEV_KEY: 'DEV-TEST-0000',

  // 授權伺服器網址（Supabase 邊緣函式），例如 https://xxxx.supabase.co/functions/v1/license
  API_URL: '',

  // 驗證用公鑰（由 license-server/tools/gen-keys.mjs 產生，整段 JSON 貼在這裡）
  PUBLIC_KEY_JWK: null,
};
