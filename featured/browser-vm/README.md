# 浏览器虚拟机

[vm-profiles.js](vm-profiles.js) 集中配置 v86 版本、固件和来宾系统。可以改 `profiles` 中的内存、启动参数和镜像，再在 [index.html](index.html) 加一个对应的选项。基于串口的 Linux 预设使用 `serial: true` 和 `console=ttyS0`，图形或文本显卡模式使用同一套启动控件。

[vm.js](vm.js) 负责加载、暂停、结束会话和串口显示。启动时才加载 [v86](https://github.com/copy/v86) 的 JavaScript、WebAssembly 和固件。Buildroot 预设使用 [Simon Willison 提供的可跨域读取的引导文件](https://tools.simonwillison.net/v86)。ELKS 使用[官方 0.9.2 软盘镜像](https://github.com/ghaerr/elks/releases/tag/v0.9.2)，下载后通过文件选择器在本地读取。

修改后可从站点根目录运行 `python -m http.server 8000`，打开 `/featured/browser-vm/` 预览。Buildroot 可用 `uname -a` 验证启动和串口输入。新增带显示输出的镜像时，也要检查屏幕焦点和下方的虚拟键盘输入框。
