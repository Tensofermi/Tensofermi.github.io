# 音乐工作台

页面把一首歌保存为六轨、四小节的音符网格。每行 64 步，每个格子是 `null` 或 MIDI 音高数组。编曲、跟弹、MIDI 导入导出共用这份数据。

- [score.js](score.js) 定义乐器轨道、音阶、和弦进行和生成规则。修改 `FORMS` 和 `SCALES` 可以改变三种风格的和声。
- [audio.js](audio.js) 定义合成音色和混音。修改 `Synth.play` 可以调整振荡器、噪声滤波和包络。
- [music-lab.js](music-lab.js) 实现网格编辑、播放调度、跟弹判定和本地存储。伴奏按 Web Audio 时钟预调度，跟弹画面也从音频时钟取样。
- [midi.js](midi.js) 实现标准 MIDI 文件与四小节网格的转换。导入按固定网格量化，导出保留当前各轨音符。

开发时用 HTTP 预览整站，例如在站点根目录运行 `python -m http.server 8000`，再打开 `/featured/music-lab/`。
