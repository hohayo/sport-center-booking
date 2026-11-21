// 驗證邏輯的自我測試：node tools/test-license.mjs
// 用暫時產生的金鑰簽出憑證（格式與 index.ts 的 sign() 相同），再用 extension/lib/license.js 驗證。
import { webcrypto as crypto } from 'node:crypto';
import { verifyToken, bytesToB64u } from '../../extension/lib/license.js';

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', publicKey);
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

async function mint(payload, signKey = privateKey) {
  const p = bytesToB64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, new TextEncoder().encode(p));
  return `${p}.${bytesToB64u(sig)}`;
}

let fail = 0;
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; };
const now = Date.now();
const good = await mint({ v: 1, device: 'dev-1', exp: now + 86400000 });

check('有效憑證通過', (await verifyToken(good, pub, 'dev-1', now)).ok === true);
check('裝置不符被拒', (await verifyToken(good, pub, 'dev-2', now)).ok === false);
check('過期被拒且 reason=expired', (await verifyToken(await mint({ v: 1, device: 'dev-1', exp: now - 1 }), pub, 'dev-1', now)).reason === 'expired');
check('用別把私鑰簽的被拒', (await verifyToken(await mint({ v: 1, device: 'dev-1', exp: now + 86400000 }, other.privateKey), pub, 'dev-1', now)).ok === false);

const [p, s] = good.split('.');
const forgedPayload = bytesToB64u(new TextEncoder().encode(JSON.stringify({ v: 1, device: 'dev-1', exp: now + 999 * 86400000 })));
check('竄改到期日被拒', (await verifyToken(`${forgedPayload}.${s}`, pub, 'dev-1', now)).ok === false);
check('竄改簽章被拒', (await verifyToken(`${p}.${s.slice(0, -2)}AA`, pub, 'dev-1', now)).ok === false);
check('亂碼被拒', (await verifyToken('abc', pub, 'dev-1', now)).ok === false);
check('空字串被拒', (await verifyToken('', pub, 'dev-1', now)).ok === false);

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
