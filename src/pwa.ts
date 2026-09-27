import { registerSW } from 'virtual:pwa-register';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPwa(inCall: () => boolean, toast: (message: string) => void) {
  const actions = document.querySelector('.top-actions')!;
  const install = document.createElement('button');
  install.className = 'text-button'; install.textContent = '安装'; install.title = '安装 MinVoice 到此设备'; install.hidden = true;
  actions.prepend(install);
  let installEvent: InstallEvent | null = null;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installEvent = event as InstallEvent; install.hidden = false; });
  install.addEventListener('click', async () => {
    if (!installEvent) return;
    try {
      await installEvent.prompt(); await installEvent.userChoice;
      installEvent = null; install.hidden = true;
    } catch { toast('请通过浏览器菜单安装或添加到主屏幕。'); }
  });
  window.addEventListener('appinstalled', () => { installEvent = null; install.hidden = true; toast('MinVoice 已安装'); });

  const update = document.createElement('button');
  update.className = 'text-button'; update.textContent = '更新'; update.hidden = true;
  actions.prepend(update);
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() { update.hidden = false; toast('新版本已就绪，可在通话结束后点击更新。'); },
    onOfflineReady() { toast('已缓存界面，可离线打开；语音需要联网。'); },
    onRegisterError() { toast('离线缓存暂不可用，联网功能不受影响。'); },
  });
  update.addEventListener('click', () => {
    if (inCall()) { toast('请先离开房间，再更新应用。'); return; }
    void updateSW(true).catch(() => toast('更新失败，请联网后重试。'));
  });
  window.addEventListener('offline', () => toast('当前离线，联网后可加入语音房间。'));
  window.addEventListener('online', () => toast('网络已恢复'));
}
