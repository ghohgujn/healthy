// Web Push без внешних библиотек: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291 / RFC 8188).
import { generateKeyPairSync, createPrivateKey, createECDH, createHmac, createCipheriv, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s).replace(/=+$/, ''), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function loadVapid(dir) {
  const file = join(dir, 'vapid.json');
  let jwk;
  if (existsSync(file)) jwk = JSON.parse(readFileSync(file, 'utf8'));
  else {
    jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  const publicRaw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { key: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: b64u(publicRaw) };
}

export function vapidHeader(vapid, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// RFC 8291: шифруем payload для подписки (p256dh, auth)
export function encrypt(payload, p256dh, auth, { salt = randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  const as = ecdh || createECDH('prime256v1'); if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Отправка; возвращает HTTP-статус push-сервиса (404/410 — подписка умерла)
export async function sendPush(vapid, sub, data, subject) {
  const body = encrypt(JSON.stringify(data), sub.p256dh, sub.auth);
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', signal: ctrl.signal, body, headers: {
      Authorization: vapidHeader(vapid, sub.endpoint, subject), 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' } });
    if (!r.ok && r.status !== 404 && r.status !== 410) console.error('push', r.status, (await r.text()).slice(0, 200));
    return r.status;
  } catch (e) { console.error('push error', e.message); return 0; } finally { clearTimeout(t); }
}
