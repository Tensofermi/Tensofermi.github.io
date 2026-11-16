'use strict';

const systems = document.getElementById('vm-systems');
const start = document.getElementById('vm-start');
const stop = document.getElementById('vm-stop');
const source = document.getElementById('vm-source');
const screen = document.getElementById('vm-screen');
const status = document.getElementById('vm-status');
const profiles = new Map([
    ['buildroot', 'Buildroot Linux'],
    ['elks', 'ELKS'],
    ['windows98', 'Windows 98'],
]);

function selectedProfile() {
    const value = systems.querySelector('input:checked')?.value;
    return profiles.has(value) ? value : 'buildroot';
}

function profileUrl(profile) {
    return `https://copy.sh/v86/?profile=${profile}`;
}

systems.addEventListener('change', () => {
    source.href = profileUrl(selectedProfile());
});

start.addEventListener('click', () => {
    const profile = selectedProfile();
    const name = profiles.get(profile);
    const frame = document.createElement('iframe');
    frame.title = `${name} 虚拟机`;
    frame.allowFullscreen = true;
    frame.src = profileUrl(profile);
    frame.addEventListener('load', () => {
        status.textContent = '等系统启动后，点击其中的画面输入。结束会话会清除本次运行状态。';
    }, { once: true });

    systems.disabled = true;
    start.hidden = true;
    stop.hidden = false;
    status.hidden = false;
    status.textContent = `正在加载 ${name}。连接较慢时可以在 copy.sh 中打开。`;
    screen.hidden = false;
    screen.replaceChildren(frame);
    stop.focus();
});

stop.addEventListener('click', () => {
    screen.replaceChildren();
    screen.hidden = true;
    systems.disabled = false;
    stop.hidden = true;
    start.hidden = false;
    status.textContent = '会话已结束。';
    start.focus();
});

systems.disabled = false;
start.disabled = false;
source.href = profileUrl(selectedProfile());
