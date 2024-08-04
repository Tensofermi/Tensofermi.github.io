const images_bg = [
    './images/header-bg0.jpg',
    './images/header-bg1.jpg',
    './images/header-bg2.jpg',
    './images/header-bg3.jpg'
];

let currentImageIndex = page_index;

const headerBg = document.querySelector('.header-bg');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');

function updateBackgroundImage() {
    headerBg.style.backgroundImage = `url('${images_bg[currentImageIndex]}')`;
    // headerBg.classList.add('fade-in');
    // setTimeout(() => headerBg.classList.remove('fade-in'), 500); // 动画持续500ms
}

prevBtn.addEventListener('click', () => {
    const variable = "1233";
    console.log(variable);
    currentImageIndex = (currentImageIndex === 0) ? images_bg.length - 1 : currentImageIndex - 1;
    updateBackgroundImage();
});

nextBtn.addEventListener('click', () => {
    const variable = "1233";
    console.log(variable);
    currentImageIndex = (currentImageIndex === images_bg.length - 1) ? 0 : currentImageIndex + 1;
    updateBackgroundImage();
});

updateBackgroundImage(); // 初始化背景图片
