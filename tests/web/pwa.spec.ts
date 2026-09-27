import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { mintToken } from '../../src/web-token';

test('browser JWT matches independent HMAC verification and rejects invalid TTL', async () => {
  const input = { apiKey: 'test-key', apiSecret: 'test-only-secret', identity: '测试用户', displayName: '昵称', room: 'test-room', ttl: '30m' };
  const token = await mintToken(input);
  const [header, body, signature] = token.split('.');
  expect(createHmac('sha256', input.apiSecret).update(`${header}.${body}`).digest('base64url')).toBe(signature);
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  expect(claims.sub).toBe(input.identity);
  expect(claims.video.room).toBe(input.room);
  expect(claims.video.roomAdmin).toBe(false);
  expect(claims.exp - claims.nbf).toBe(1810);
  await expect(mintToken({ ...input, ttl: 'forever' })).rejects.toThrow('有效期');
});

async function configure(page: Page, input: { url: string; apiKey: string; apiSecret: string; identity: string; room: string; displayName: string }) {
  await page.goto('/');
  await expect(page.locator('#join-button')).toBeEnabled();
  await page.locator('#settings-open').click();
  for (const [key, value] of Object.entries(input)) await page.locator(`#settings-form [name="${key}"]`).fill(value);
  await page.locator('#save-button').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
}

test('installable PWA loads offline and keeps API secret out of persistent settings', async ({ page, context, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBeTruthy();
  await configure(page, { url: 'wss://example.invalid', apiKey: 'test-key', apiSecret: 'test-only-secret', identity: 'pwa-test', room: 'test-room', displayName: '测试' });
  expect(await page.evaluate(() => localStorage.getItem('minvoice:web:settings'))).not.toContain('test-only-secret');
  await page.reload();
  await page.locator('#settings-open').click();
  await expect(page.locator('[name=apiSecret]')).toHaveValue('');
  await expect(page.locator('[name=apiSecret]')).toHaveAttribute('placeholder', /已保存/);
  await page.locator('#settings-close').click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#join-button')).toBeEnabled();
  await page.locator('#join-button').click();
  await expect(page.locator('#notice')).toContainText('离线');
  await context.setOffline(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/pwa-mobile.png' });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('#settings-open').click();
  await expect(page.locator('[name=apiSecret]')).toHaveAttribute('placeholder', '输入 API Secret');
  expect(errors).toEqual([]);
});

test('two browsers exchange live audio and chat, preserve volume and release microphone', async ({ browser, baseURL }) => {
  test.skip(!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET, 'Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET for real SFU validation');
  test.setTimeout(120_000);
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  for (const context of contexts) await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    (window as any).__testPeers = peers;
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) { super(config); peers.push(this); }
    };
  });
  const [alice, bob] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  [alice, bob].forEach(page => page.on('pageerror', error => errors.push(error.message)));
  const room = `minvoice-pwa-e2e-${Date.now()}`;
  const credentials = { url: process.env.LIVEKIT_URL!, apiKey: process.env.LIVEKIT_API_KEY!, apiSecret: process.env.LIVEKIT_API_SECRET!, room };
  const received = (page: Page) => page.evaluate(async () => {
    let total = 0;
    for (const peer of (window as any).__testPeers as RTCPeerConnection[]) {
      for (const stat of (await peer.getStats()).values()) if (stat.type === 'inbound-rtp' && stat.kind === 'audio') total += stat.bytesReceived || 0;
    }
    return total;
  });
  try {
    await configure(alice, { ...credentials, identity: 'alice', displayName: 'Alice' });
    await configure(bob, { ...credentials, identity: 'bob', displayName: 'Bob' });
    await alice.locator('#join-button').click(); await bob.locator('#join-button').click();
    await expect(alice.locator('#connection')).toHaveText('已连接', { timeout: 45_000 });
    await expect(bob.locator('#connection')).toHaveText('已连接', { timeout: 45_000 });
    await expect(alice.locator('.participant')).toHaveCount(2);
    await expect(bob.locator('.participant')).toHaveCount(2);
    await expect.poll(() => received(alice), { timeout: 30_000 }).toBeGreaterThan(1000);
    await expect.poll(() => received(bob), { timeout: 30_000 }).toBeGreaterThan(1000);
    await alice.locator('#chat-toggle').click(); await bob.locator('#chat-toggle').click();
    await alice.locator('#chat-input').fill('网页版语音已连通'); await alice.locator('#send-button').click();
    await expect(bob.locator('.message p')).toHaveText('网页版语音已连通');
    await bob.locator('#chat-input').fill('收到'); await bob.locator('#send-button').click();
    await expect(alice.locator('.message p')).toHaveText(['网页版语音已连通', '收到']);
    await alice.locator('#mic-toggle').click();
    await expect(bob.locator('[data-identity=alice] .participant-state')).toContainText('麦克风已关闭');
    await alice.locator('#mic-toggle').click();
    const slider = alice.locator('[data-identity=bob] input[type=range]');
    await slider.fill('150'); await slider.dispatchEvent('input');
    await expect.poll(() => alice.evaluate(() => localStorage.getItem('minvoice:web:volumes'))).toContain('150');
    await alice.locator('#deafen-toggle').click(); await expect(alice.locator('#deafen-toggle')).toHaveAttribute('aria-pressed', 'true');
    await alice.locator('#deafen-toggle').click();
    await alice.locator('#leave-button').click();
    await expect(alice.locator('#connection')).toHaveText('未连接');
    await expect(bob.locator('.participant')).toHaveCount(1);
    expect(await alice.evaluate(() => (window as any).__testPeers.every((p: RTCPeerConnection) => p.connectionState === 'closed'))).toBeTruthy();
    await alice.locator('#join-button').click();
    await expect(alice.locator('#connection')).toHaveText('已连接', { timeout: 45_000 });
    await expect(alice.locator('[data-identity=bob] input[type=range]')).toHaveValue('150');
    const before = await received(alice);
    await expect.poll(() => received(alice), { timeout: 15_000 }).toBeGreaterThan(before + 1000);
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
