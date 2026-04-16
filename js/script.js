const scriptTag = document.querySelector('script[src$="js/script.js"]');
const assetBaseUrl = scriptTag ? new URL('../images/', scriptTag.src).href : './images/';
const images_bg = [
    new URL('header-bg0.jpg', assetBaseUrl).href,
    new URL('header-bg1.jpg', assetBaseUrl).href,
    new URL('header-bg2.jpg', assetBaseUrl).href,
    new URL('header-bg3.jpg', assetBaseUrl).href
];

let currentImageIndex = page_index;

const headerBg = document.querySelector('.header-bg');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

function updateBackgroundImage() {
    if (!headerBg) {
        return;
    }

    headerBg.style.backgroundImage = `url('${images_bg[currentImageIndex]}')`;
}

if (prevBtn) {
    prevBtn.addEventListener('click', () => {
        currentImageIndex = currentImageIndex === 0 ? images_bg.length - 1 : currentImageIndex - 1;
        updateBackgroundImage();
    });
}

if (nextBtn) {
    nextBtn.addEventListener('click', () => {
        currentImageIndex = currentImageIndex === images_bg.length - 1 ? 0 : currentImageIndex + 1;
        updateBackgroundImage();
    });
}

updateBackgroundImage();
