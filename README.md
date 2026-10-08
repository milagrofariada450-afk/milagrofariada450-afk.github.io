# 研读 · 论文阅读 PWA

这是一个本地优先、纯静态的论文阅读应用，适合在手机上读论文。可以在 iOS Safari 或 Android Chrome 里「添加到主屏幕」，之后像 App 一样全屏使用，也能离线打开。

- **导入**：可多选本机 PDF，也可以输入 arXiv 编号或链接导入。PDF 存在浏览器的 IndexedDB 里。导入时会自动识别标题和作者，之后可以手动修改。
- **书架**：支持搜索、标签、收藏、阅读进度、排序和删除。
- **两种阅读模式**
  - 原版：用 pdf.js 渲染，宽度适配屏幕，支持双指缩放和双击缩放，带文本层，可以选中文字。
  - 重排：按段落和标题重新排版，处理了双栏顺序和连字符，去掉页眉、页脚和页码。公式和图表直接截取原图显示。
- **划线与笔记**：两种模式都能划线，四种颜色，可写笔记，还能「问 AI」。有笔记面板，可导出 Markdown。
- **显示设置**：字号、行距、衬线 / 无衬线，背景可选白 / 护眼 / 夜间，外观可跟随系统。
- **阅读位置**：按论文分别记住，两种模式各自独立；进度显示在书架上的「继续阅读」卡片里。
- **AI（可插拔）**：在「我的」页面填写任意 OpenAI 兼容接口（Base URL、Key、模型），用于点按翻译、双语对照、仅译文和 AI 速读。译文会缓存在本机。代码里没有内置任何密钥。

## 目录

```
index.html  manifest.webmanifest  sw.js
css/        base.css（沿用原型的设计） app.css（应用专用样式）
js/         app.js（书架、导入、笔记、设置）  reader.js（阅读器）  reflow.js（重排引擎）
            pdfview.js（pdf.js 封装）  db.js（IndexedDB）  ai.js（OpenAI 兼容接口）  util.js
vendor/pdfjs/  pdf.js 6.4.299 legacy 构建，已本地化（含 cmaps、标准字体、wasm），运行时不访问 CDN
icons/      192、512、maskable 512、apple-touch-icon 180、favicon
tools/      serve.py（本地预览）  build-sw.mjs（生成离线缓存清单）  package.sh（打包 dist/）
            e2e.mjs / e2e-ai.mjs（Playwright 测试）  icon.mjs（生成图标）
test-pdfs/  测试用的 arXiv 论文，不需要部署
```

## 本地预览

```bash
python3 tools/serve.py 8080     # 浏览器打开 http://localhost:8080/
```

Service Worker 只能在 `https://` 或 `localhost` 下工作。用手机通过局域网 IP（http）访问时，可以正常阅读，但不能离线，也不能安装。

## 部署（任意静态托管，必须是 HTTPS）

1. 生成 `dist/` 和 `yandu-pwa.zip`：

   ```bash
   ./tools/package.sh
   ```

   这个脚本会先运行 `node tools/build-sw.mjs`。它根据文件内容的哈希更新 `sw.js` 的版本号和预缓存清单。**每次改完代码，部署前都要运行一次**，否则用户收不到更新。用户端会出现「新版本已就绪 · 立即刷新」的提示条。
2. 把 `dist/` 里的全部内容上传到静态托管。所有路径都是相对路径，放在子路径下也能用（例如 `https://用户名.github.io/yandu/`）。可选的托管方式：
   - **GitHub Pages**：把 `dist/` 的内容推送到仓库的 `gh-pages` 分支，或推到主分支的 `/docs` 目录。已包含 `.nojekyll`。
   - **Cloudflare Pages / Netlify / Vercel**：构建命令留空，输出目录填 `dist`（也可以直接拖拽上传文件夹）。
   - **自有服务器**（Nginx 等）：确保 MIME 类型正确：`.mjs` → `text/javascript`，`.wasm` → `application/wasm`，`.webmanifest` → `application/manifest+json`。建议给 `sw.js` 加 `Cache-Control: no-cache`。
   - 如果要在中国大陆稳定访问，GitHub Pages 和 Cloudflare 有时较慢，可以考虑国内对象存储加 CDN（需要 ICP 备案的域名）。
3. 体积：约 5.7 MB（zip 后约 2.6 MB）。其中 pdf.js 约 5.3 MB。首次打开时会预缓存约 4 MB；cmaps（约 1.7 MB）只在打开中日韩字体的 PDF 时按需缓存。
4. 不需要后端、数据库，也不需要任何环境变量或密钥。

## 注意事项

- **数据只在本机**：论文、笔记、AI 密钥都保存在当前设备当前浏览器里，不会同步。清除浏览器数据会一并删除，请定期在「我的 → 导出全部笔记」导出。
- **iOS**：建议「添加到主屏幕」后使用。Safari 会清理长期不访问的网站数据，主屏幕应用不受这一限制，也更容易拿到持久存储。另外，主屏幕应用和 Safari 标签页的存储是分开的。
- **AI 接口**：请求直接从浏览器发出，因此接口必须允许浏览器跨域（CORS）。OpenAI、DeepSeek 等主流服务一般可以；如果「测试连接」失败，可以换一家服务，或自建一个带 CORS 的转发。HTTPS 页面不能调用 `http://` 接口，所以 Ollama 本机接口只适合在 `localhost` 预览时使用。
- **arXiv 导入**：arxiv.org 的 PDF 当前允许跨域下载。如果网络或策略导致下载失败，应用会提示用户手动下载后再导入。

## 测试

```bash
python3 tools/serve.py 8080 &
node tools/e2e.mjs      # 导入、两种模式、划线持久化、删除、离线、控制台错误，并输出截图
node tools/e2e-ai.mjs   # 用模拟的 OpenAI 兼容接口测试翻译和速读；测试阅读位置恢复和 arXiv 导入
```

测试脚本默认使用 `/tmp/pdfjs/node_modules/playwright-core` 和 `/usr/bin/google-chrome`，换环境时需要改成对应的路径。

线上地址：https://milagrofariada450-afk.github.io/
