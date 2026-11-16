// Guest settings live here so a different x86 kernel or disk can use the same controls.
const MiB = 1024 * 1024;
const version = '0.5.473';
const release = `https://cdn.jsdelivr.net/npm/v86@${version}/build/`;
const firmware = 'https://cdn.jsdelivr.net/gh/copy/v86@1e4f43c954701db9699fa976b27cc675f9971265/bios/';

export const runtime = {
    library: `${release}libv86.mjs`,
    wasm: `${release}v86.wasm`,
    fallback: `${release}v86-fallback.wasm`,
    bios: `${firmware}seabios.bin`,
    vga: `${firmware}vgabios.bin`,
};

export const profiles = {
    buildroot: {
        name: 'Buildroot Linux',
        serial: true,
        startupFile: 'https://static.simonwillison.net/static/cors-allow/2026/buildroot-bzimage68.bin',
        options: {
            memory_size: 64 * MiB,
            cmdline: 'console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on',
        },
    },
    elks: {
        name: 'ELKS',
        localMedia: 'fda',
        options: {
            memory_size: 16 * MiB,
        },
    },
    local: {
        name: '本地镜像',
        localMedia: 'select',
        options: { memory_size: 128 * MiB },
    },
};

export const localMedia = {
    hda: { bootOrder: 0x132, maxSize: 512 * MiB },
    fda: { bootOrder: 0x231, maxSize: 4 * MiB },
    cdrom: { bootOrder: 0x213, maxSize: 512 * MiB },
};
