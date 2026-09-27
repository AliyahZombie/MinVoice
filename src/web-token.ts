export interface TokenInput {
  apiKey: string; apiSecret: string; identity: string; displayName: string; room: string; ttl: string;
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

export async function mintToken(input: TokenInput): Promise<string> {
  if (!input.apiKey || !input.apiSecret || !input.identity || !input.room) throw new Error('请填写服务器凭据、参与者 ID 和房间。');
  const ttl = /^(\d+)([smhd]?)$/i.exec(input.ttl.trim() || '6h');
  if (!ttl) throw new Error('有效期请使用 30m、6h、7d 或秒数。');
  const seconds = Math.max(30, Number(ttl[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[ttl[2].toLowerCase()] ?? 1));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now + seconds)) throw new Error('有效期过大。');
  const body = {
    iss: input.apiKey, sub: input.identity, name: input.displayName || input.identity,
    nbf: now - 10, exp: now + seconds, jti: crypto.randomUUID(), kind: 'standard',
    video: { room: input.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: false },
  };
  const signingInput = `${json({ alg: 'HS256', typ: 'JWT' })}.${json(body)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(input.apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${encode(new Uint8Array(signature))}`;
}
