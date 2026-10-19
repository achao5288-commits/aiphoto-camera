# 取景助手

实时识别人体姿态，在画面上画出一个最佳取景框，并用屏幕文字提示人往哪站、手机往哪转。对齐后可直接按快门保存。

## 本地运行

```bash
cd camera
python -m http.server 8000
# iOS 真机需 HTTPS；桌面 Chrome 用 http://localhost:8000/
```

不能直接双击 `index.html`（`file://` 下浏览器禁用相机）。

## 使用

- **自动 / 全身 / 半身**：自动按可见关键点判断；也可手动锁定场景。
- **用这个框**：锁定当前框，框外压暗；再点一次“重选框”。
- 框变绿并显示“可以拍了 · 保持住”时按快门。
- **前后**：切换前后摄像头（前置画面与关键点同时镜像）。

调试参数：`?debug=1` 显示关键点骨架与尺寸；`?mock=1&variant=ok_full` 用合成姿态演示，不打开相机。

## 部署

纯静态文件，直接放到任意 HTTPS 静态托管即可（GitHub Pages 已配置 `.nojekyll`）。

## 隐私

- 相机画面只在浏览器本地处理，不上传，无统计、无后端。
- 本仓库不含任何用户照片或学习用的参考图。

## 第三方

- MediaPipe Tasks Vision 0.10.14（Apache-2.0）
- MediaPipe Pose Landmarker lite 模型（Apache-2.0）

完整许可见 `NOTICE`。首次加载约 25 MB，之后走浏览器缓存。
