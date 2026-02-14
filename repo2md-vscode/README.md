# 📘 Repo to Markdown / 项目转 Markdown
[中文](#中文) | [English](#english)
---
## English
### 📖 Overview
A powerful VS Code extension that converts your project structure and file contents into a single, well-formatted Markdown document. Perfect for code reviews, documentation, AI context sharing, and project archiving.
### ✨ Features
| Feature | Description |
|---------|-------------|
| 🌳 **Directory Tree** | Generates an ASCII-style directory structure |
| 📄 **File Content** | Includes selected file contents with syntax highlighting |
| 🔍 **Extension Filter** | Filter files by extension |
| 📊 **Size Display** | Shows file sizes in the tree view |
| 🚫 **Binary Detection** | Automatically skips binary files |
| 🔐 **Security Check** | Warns about potential sensitive files |
| 📋 **Export Options** | Copy to clipboard or save as .md file |
| 🔄 **Auto Refresh** | Monitors file changes in real-time |
### 📦 Installation
1. Open VS Code
2. Press `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (Mac) to open Extensions
3. Search for `Repo to Markdown`
4. Click **Install**
### 🚀 Usage
1. Open a folder/workspace in VS Code
2. Press `Ctrl+Shift+P` to open Command Palette
3. Type `Repo to Markdown` and press Enter
4. Select the files you want to include (use checkboxes)
5. Click **Generate Markdown**
6. Copy or export the result
### ⚙️ Features in Detail
#### Ignored Directories
The following directories are automatically excluded:
- Version Control: `.git`, `.svn`, `.hg`
- Dependencies: `node_modules`, `vendor`, `packages`
- Build Output: `dist`, `build`, `out`, `target`
- IDE Config: `.vscode`, `.idea`, `.vs`
- Cache: `.cache`, `__pycache__`, `.pytest_cache`
#### Binary File Detection
Files are detected as binary through:
- File extension (`.png`, `.jpg`, `.exe`, etc.)
- Magic number detection (PDF, PNG, JPEG, ZIP, GZIP)
#### Security Warning
The extension warns when selecting files that may contain sensitive information:
- `.env` files
- Files containing `secret`, `password`, `key`, `token`
### 📋 Requirements
- VS Code `^1.85.0` or higher
### 🐛 Known Issues
- Very large projects may take longer to scan
- Some edge cases with symlink handling
### 📝 Release Notes
#### 0.0.1
- Initial release
- Basic project scanning and Markdown generation
---
## 中文
### 📖 概述
一款强大的 VS Code 扩展，可将您的项目结构和文件内容转换为格式规范的 Markdown 文档。非常适合代码审查、文档编写、AI 上下文共享和项目归档。
### ✨ 功能特性
| 功能 | 说明 |
|------|------|
| 🌳 **目录树生成** | 生成 ASCII 风格的目录结构 |
| 📄 **文件内容** | 包含选中文件的内容，支持语法高亮 |
| 🔍 **后缀筛选** | 按文件后缀过滤文件 |
| 📊 **大小显示** | 在树视图中显示文件大小 |
| 🚫 **二进制检测** | 自动跳过二进制文件 |
| 🔐 **安全检查** | 警告可能包含敏感信息的文件 |
| 📋 **导出选项** | 复制到剪贴板或保存为 .md 文件 |
| 🔄 **自动刷新** | 实时监控文件变更 |
### 📦 安装方法
1. 打开 VS Code
2. 按 `Ctrl+Shift+X`（Windows/Linux）或 `Cmd+Shift+X`（Mac）打开扩展面板
3. 搜索 `Repo to Markdown`
4. 点击 **安装**
### 🚀 使用方法
1. 在 VS Code 中打开一个文件夹/工作区
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 `Repo to Markdown` 并按回车
4. 使用复选框选择要包含的文件
5. 点击 **生成 Markdown**
6. 复制或导出结果
### ⚙️ 详细功能
#### 自动忽略的目录
以下目录会被自动排除：
- 版本控制：`.git`、`.svn`、`.hg`
- 依赖包：`node_modules`、`vendor`、`packages`
- 构建输出：`dist`、`build`、`out`、`target`
- IDE 配置：`.vscode`、`.idea`、`.vs`
- 缓存目录：`.cache`、`__pycache__`、`.pytest_cache`
#### 二进制文件检测
通过以下方式检测二进制文件：
- 文件扩展名（`.png`、`.jpg`、`.exe` 等）
- 魔数检测（PDF、PNG、JPEG、ZIP、GZIP）
#### 安全警告
当选择可能包含敏感信息的文件时，扩展会发出警告：
- `.env` 文件
- 包含 `secret`、`password`、`key`、`token` 的文件
### 📋 系统要求
- VS Code `^1.85.0` 或更高版本
### 🐛 已知问题
- 超大型项目扫描可能需要较长时间
- 符号链接处理的某些边缘情况
### 📝 更新日志
#### 0.0.1
- 初始版本发布
- 基础项目扫描和 Markdown 生成功能
---
## 🤝 Contributing / 参与贡献
Contributions are welcome! Feel free to submit issues and pull requests.
欢迎贡献！随时提交问题和拉取请求。
## 📄 License / 许可证
GPL License
---
<p align="center">
  <b>Made with ❤️ for developers</b>
</p>
