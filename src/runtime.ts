import { invoke as nativeInvoke, isTauri } from '@tauri-apps/api/core';
import { listen as nativeListen } from '@tauri-apps/api/event';

export const desktop = isTauri();
const browser = () => import('./web-runtime');

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return desktop ? nativeInvoke<T>(command, args) : (await browser()).invoke<T>(command, args);
}

export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  return desktop ? nativeListen<T>(event, handler) : (await browser()).listen(event, handler);
}
