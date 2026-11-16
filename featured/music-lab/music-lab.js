const workspace = document.querySelector('.music-workspace');
const surface = document.querySelector('#music-surface');
const launch = document.querySelector('#music-launch');
const start = document.querySelector('#music-start');
const source = document.querySelector('#music-source');
const status = document.querySelector('#music-status');
const fullscreen = document.querySelector('#music-fullscreen');

function startOurtone() {
    launch.hidden = true;
    workspace.classList.add('is-running');
    fullscreen.hidden = !document.fullscreenEnabled;
    status.textContent = '正在加载 Ourtone…';
    status.hidden = false;

    const appUrl = new URL(source.href);
    const frame = document.createElement('iframe');
    frame.className = 'music-frame';
    frame.title = 'Ourtone 音乐工作台';
    frame.allow = ['autoplay', 'fullscreen', 'microphone']
        .map(feature => `${feature} ${appUrl.origin}`)
        .join('; ');

    const slowLoad = window.setTimeout(() => {
        status.textContent = '加载较慢，也可以在原站打开。';
    }, 12000);

    frame.addEventListener('load', () => {
        window.clearTimeout(slowLoad);
        status.hidden = true;
    }, { once: true });
    frame.src = appUrl.href;
    surface.prepend(frame);
    workspace.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    frame.focus({ preventScroll: true });
}

start.addEventListener('click', startOurtone, { once: true });
launch.hidden = false;

fullscreen.addEventListener('click', async () => {
    try {
        if (document.fullscreenElement === workspace) {
            await document.exitFullscreen();
        } else {
            await workspace.requestFullscreen();
        }
    } catch {
        status.textContent = '当前浏览器无法全屏，可以在原站打开。';
        status.hidden = false;
        window.setTimeout(() => { status.hidden = true; }, 4000);
    }
});

document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement === workspace ? '退出全屏' : '全屏';
});
