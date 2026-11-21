// 產生授權用的金鑰對（ECDSA P-256）。只需要執行一次。
//   node tools/gen-keys.mjs
// 產出：
//   keys/private.jwk.json  → 私鑰。設成 Supabase secret：LICENSE_PRIVATE_JWK。絕對不要放進擴充程式、不要上傳到 GitHub。
//   螢幕上印出的公鑰        → 貼到 extension/config.js 的 PUBLIC_KEY_JWK。
import { webcrypto as crypto } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

if (existsSync('keys/private.jwk.json')) {
  console.error('keys/private.jwk.json 已存在，為避免覆蓋已發出的授權，請先手動移走再重新產生。');
  process.exit(1);
}
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', publicKey);
const priv = await crypto.subtle.exportKey('jwk', privateKey);

mkdirSync('keys', { recursive: true });
writeFileSync('keys/private.jwk.json', JSON.stringify(priv));
writeFileSync('keys/.gitignore', '*\n');

console.log('已寫入 keys/private.jwk.json（私鑰，請妥善保管）\n');
console.log('=== 公鑰：貼到 extension/config.js 的 PUBLIC_KEY_JWK ===');
console.log(JSON.stringify(pub));
console.log('\n=== 設定 Supabase secret ===');
console.log("supabase secrets set LICENSE_PRIVATE_JWK='" + JSON.stringify(priv) + "'");
