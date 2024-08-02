const images_bg = [
    './images/header-bg1.jpg',
    './images/header-bg2.jpg',
    './images/header-bg3.jpg' // 添加更多图片路径
];

let currentImageIndex = 2;

const headerBg = document.querySelector('.header-bg');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

function updateBackgroundImage() {
    headerBg.style.backgroundImage = `url('${images_bg[currentImageIndex]}')`;
}

prevBtn.addEventListener('click', () => {
    currentImageIndex = (currentImageIndex === 0) ? images_bg.length - 1 : currentImageIndex - 1;
    updateBackgroundImage();
});

nextBtn.addEventListener('click', () => {
    currentImageIndex = (currentImageIndex === images_bg.length - 1) ? 0 : currentImageIndex + 1;
    updateBackgroundImage();
});

updateBackgroundImage(); // 初始化背景图片
