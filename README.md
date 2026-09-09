<div align="center">
  <h1>Fast UOOC</h1>
  <p>让UOOC课程播放更顺畅，减少重复操作，把注意力留给学习本身。</p>
  <p>
    <a href="https://raw.githubusercontent.com/Liunian06/fastuooc/main/uooc-auto-player.user.js">
      <img src="https://img.shields.io/badge/Tampermonkey-一键安装-2563EB?style=flat-square" alt="一键安装">
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/badge/License-MIT-16A34A?style=flat-square" alt="MIT许可证">
    </a>
  </p>
</div>

## 脚本介绍

Fast UOOC是一款面向UOOC在线学习页面的Tampermonkey用户脚本，专注于减少播放器和课程目录中的重复操作。

- 自动应用2倍速和静音设置。
- 自动选择可用视频资源，当前线路失败时尝试其他线路。
- 当前视频播放完成后，自动进入同章节的下一个视频；章节结束后继续进入下一章节。
- 兼容旧版Angular目录结构和新版HTML5 Video/Video.js播放器。
- 尝试维持浏览器后台播放，并在播放器暂停后恢复播放状态。
- 提供简洁的悬浮控制面板，支持跟随系统、浅色和深色三种主题。
- 支持导出测验题目和选项，并通过OpenAI兼容接口生成仅供参考的AI答案。

## 如何安装

**一键安装**

点击下面的链接，Tampermonkey会自动打开安装页面：

<p>
  <a href="https://raw.githubusercontent.com/Liunian06/fastuooc/main/uooc-auto-player.user.js"><strong>安装Fast UOOC</strong></a>
</p>

**手动安装**

1. 安装[Tampermonkey](https://www.tampermonkey.net/)。
2. 打开仓库中的`uooc-auto-player.user.js`。
3. 将脚本内容复制到Tampermonkey的新脚本中并保存。
4. 打开或刷新UOOC课程页面。

## 使用说明

脚本加载后，悬浮窗会出现在页面右下角。

| 功能 | 说明 |
| --- | --- |
| 自动控制 | 总控开关。开启后自动连播、静音和后台播放同时开启，并暂时锁定为不可单独修改。 |
| 自动连播 | 视频结束后按课程目录顺序寻找下一个可用视频，必要时自动进入下一章节。 |
| 静音 | 让播放器保持静音，并在播放器重建或切换线路后重新应用。 |
| 后台播放 | 尝试阻止平台的失焦暂停，并在浏览器切到后台后恢复播放。 |
| 界面主题 | 在跟随系统、浅色和深色之间切换。 |
| 导出题目 | 将当前页面已经渲染的题目和选项导出为Markdown文件。 |

**AI参考**

1. 点击“AI设置”，填写OpenAI兼容Chat Completions接口地址、API Key、模型名称和超时时间。
2. 点击“AI参考”，脚本会按题目独立请求AI；全局同时最多10个请求。
3. 尚未开始执行的题目显示“等待分析中…”，真正开始请求后显示“分析中…”。
4. 每道题先请求3次，结果不一致时追加2次，最终选择唯一票数最高的答案；并列时显示“无法确定”。
5. 同时支持单选题和多选题。多选题按完整选项组合进行判断，不会将不同回答错误拼接。
6. 页面已有参考结果时，再次点击会询问“覆盖全部”或“仅重试无法确定”。

AI参考不会修改选项状态，也不会自动提交测验。请结合课程材料独立判断结果。

## 许可证

本项目采用[MIT许可证](LICENSE)开源。
