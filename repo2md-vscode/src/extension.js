"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
// 二进制扩展名黑名单（同原项目）
const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
    'mp4', 'mp3', 'avi', 'mov', 'wmv', 'flv',
    'pdf', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'rar', '7z', 'tar', 'gz',
    'exe', 'dll', 'so', 'dylib',
    'iso', 'img',
    'woff', 'woff2', 'ttf', 'eot',
    'psd', 'ai', 'eps',
    'bin', 'dat', 'db', 'sqlite', 'cur', 'icns'
]);
// 获取文件扩展名
function getExtension(filePath) {
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1];
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex === -1 ? '[无后缀]' : fileName.substring(dotIndex + 1).toLowerCase();
}
// 检测二进制文件（扩展名 + 魔数）
async function isBinaryFile(filePath) {
    const ext = getExtension(filePath);
    if (BINARY_EXTENSIONS.has(ext)) {
        return true;
    }
    try {
        const fd = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(4);
        const { bytesRead } = await fd.read(buffer, 0, 4, 0);
        await fd.close();
        if (bytesRead < 4)
            return false;
        // 常见魔数判断
        if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46)
            return true; // PDF
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47)
            return true; // PNG
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF)
            return true; // JPEG
        if (buffer[0] === 0x50 && buffer[1] === 0x4B)
            return true; // ZIP
        if (buffer[0] === 0x1F && buffer[1] === 0x8B)
            return true; // GZIP
    }
    catch {
        return true; // 读取失败也视为二进制
    }
    return false;
}
// 递归读取文件夹，返回文件信息列表
async function readDirectoryRecursive(dirPath, basePath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/'); // 统一分隔符
        if (entry.isDirectory()) {
            const subResults = await readDirectoryRecursive(fullPath, basePath);
            results.push(...subResults);
        }
        else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            results.push({ path: relativePath, size: stat.size });
        }
    }
    return results;
}
// 格式化字节
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
// 生成 ASCII 目录树
function generateDirectoryTree(files, rootName) {
    // 构建树结构
    const tree = {};
    files.forEach(filePath => {
        const parts = filePath.split('/');
        let current = tree;
        parts.forEach((part, idx) => {
            if (!current[part]) {
                current[part] = { __children: {} };
            }
            if (idx === parts.length - 1) {
                current[part].__file = true;
            }
            current = current[part].__children;
        });
    });
    function buildTreeString(node, prefix = '', isLast = true) {
        const entries = Object.entries(node).sort(([aName, aData], [bName, bData]) => {
            const aIsDir = !aData.__file;
            const bIsDir = !bData.__file;
            if (aIsDir !== bIsDir)
                return aIsDir ? -1 : 1;
            return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
        });
        let result = '';
        entries.forEach(([name, data], index) => {
            const isLastEntry = index === entries.length - 1;
            const hasChildren = Object.keys(data.__children || {}).length > 0;
            const isFile = !!data.__file;
            result += prefix + (isLast ? '└── ' : '├── ') + name;
            if (!isFile && hasChildren)
                result += '/';
            result += '\n';
            if (hasChildren) {
                const childPrefix = prefix + (isLast ? '    ' : '│   ');
                result += buildTreeString(data.__children, childPrefix, isLastEntry);
            }
        });
        return result;
    }
    let treeString = `${rootName}/\n`;
    if (files.length === 0) {
        treeString += '└── (无选中文件)\n';
    }
    else {
        treeString += buildTreeString(tree, '', true);
    }
    return treeString;
}
// 读取文件内容（文本）
async function readTextFile(filePath) {
    return await fs.readFile(filePath, 'utf-8');
}
function activate(context) {
    const command = vscode.commands.registerCommand('repo2md.start', async () => {
        // 创建 Webview 面板
        const panel = vscode.window.createWebviewPanel('repo2md', 'Repo to Markdown', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        });
        // 设置 HTML 内容
        panel.webview.html = getWebviewContent();
        // 当前选择的文件夹路径和文件列表
        let currentFolderPath;
        let currentFiles = [];
        // 处理来自 Webview 的消息
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'pickFolder':
                    {
                        // 显示文件夹选择对话框
                        const options = {
                            canSelectFiles: false,
                            canSelectFolders: true,
                            canSelectMany: false,
                            openLabel: '选择文件夹'
                        };
                        const folderUri = await vscode.window.showOpenDialog(options);
                        if (folderUri && folderUri[0]) {
                            currentFolderPath = folderUri[0].fsPath;
                            vscode.window.showInformationMessage(`正在扫描文件夹: ${currentFolderPath}`);
                            try {
                                currentFiles = await readDirectoryRecursive(currentFolderPath, currentFolderPath);
                                const folderName = path.basename(currentFolderPath);
                                const fileList = currentFiles.map(f => ({
                                    path: f.path,
                                    size: f.size,
                                    extension: getExtension(f.path)
                                }));
                                panel.webview.postMessage({
                                    command: 'folderData',
                                    projectName: folderName,
                                    files: fileList
                                });
                            }
                            catch (err) {
                                vscode.window.showErrorMessage(`扫描失败: ${err.message}`);
                            }
                        }
                    }
                    break;
                case 'generateMarkdown':
                    {
                        if (!currentFolderPath || currentFiles.length === 0) {
                            vscode.window.showErrorMessage('请先选择一个文件夹');
                            return;
                        }
                        const selectedPaths = message.selectedPaths;
                        if (selectedPaths.length === 0) {
                            vscode.window.showWarningMessage('未选中任何文件');
                            return;
                        }
                        const projectName = message.projectName || path.basename(currentFolderPath);
                        const rootPath = currentFolderPath;
                        // 生成 Markdown
                        const mdParts = [];
                        mdParts.push(`# 项目概览：${projectName}\n`);
                        mdParts.push(`## 📁 目录结构\n`);
                        mdParts.push('```\n' + generateDirectoryTree(selectedPaths, projectName) + '```\n');
                        if (selectedPaths.length === 0) {
                            mdParts.push('*(未选中任何文件)*');
                        }
                        else {
                            mdParts.push(`## 📄 文件内容\n`);
                            const total = selectedPaths.length;
                            for (let i = 0; i < total; i++) {
                                const relPath = selectedPaths[i];
                                const fullPath = path.join(rootPath, relPath);
                                const ext = getExtension(relPath);
                                // 发送进度
                                panel.webview.postMessage({
                                    command: 'generateProgress',
                                    current: i + 1,
                                    total,
                                    file: relPath
                                });
                                try {
                                    const isBinary = await isBinaryFile(fullPath);
                                    if (isBinary) {
                                        mdParts.push(`### \`${relPath}\`\n\`\`\`\n[二进制文件，已跳过]\n\`\`\``);
                                    }
                                    else {
                                        const content = await readTextFile(fullPath);
                                        mdParts.push(`### \`${relPath}\`\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
                                    }
                                }
                                catch (err) {
                                    mdParts.push(`### \`${relPath}\`\n\`\`\`\n[读取失败: ${err.message}]\n\`\`\``);
                                }
                            }
                        }
                        const markdown = mdParts.join('\n\n');
                        panel.webview.postMessage({
                            command: 'markdownResult',
                            markdown
                        });
                    }
                    break;
                case 'exportMarkdown':
                    {
                        const content = message.content;
                        if (!content) {
                            vscode.window.showErrorMessage('没有可导出的内容');
                            return;
                        }
                        const defaultName = message.projectName || 'project';
                        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                        const defaultFileName = `${defaultName}_${date}.md`;
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file(defaultFileName),
                            filters: { 'Markdown': ['md'] }
                        });
                        if (uri) {
                            await fs.writeFile(uri.fsPath, content, 'utf-8');
                            vscode.window.showInformationMessage(`导出成功: ${uri.fsPath}`);
                        }
                    }
                    break;
            }
        });
    });
    context.subscriptions.push(command);
}
function deactivate() { }
// 生成 Webview HTML（包含内联的 JS 和 CSS）
function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Repo to Markdown</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/jstree@3.3.12/dist/themes/default/style.min.css">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 1rem; }
    textarea { width: 100%; margin-top: 1rem; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: monospace; }
    .file-picker-btn { display: block; width: 100%; padding: 2rem; background-color: #007bff; color: white; text-align: center; font-size: 1.5rem; font-weight: bold; border-radius: 8px; cursor: pointer; transition: 0.3s; border: none; margin-bottom: 1rem; }
    .file-picker-btn:hover { background-color: #0056b3; transform: scale(1.02); }
    button { padding: 0.5rem 1rem; margin: 0.5rem 0.5rem 0.5rem 0; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background-color: #218838; }
    #extension-filters label { margin-right: 1rem; font-size: 0.9rem; }
    #tree-container { margin: 1rem 0; border: 1px solid #ddd; padding: 1rem; border-radius: 4px; max-height: 400px; overflow: auto; }
    #scan-progress, #generate-progress { margin: 10px 0; padding: 8px; background: #f0f0f0; border-radius: 4px; }
    #generate-progress { background: #e3f2fd; }
  </style>
</head>
<body>
  <h1>📘 项目转 Markdown</h1>

  <button id="pick-folder-btn" class="file-picker-btn">📁 选择文件夹</button>

  <div>
    <label><strong>后缀筛选</strong></label>
    <div id="extension-filters"></div>
  </div>

  <div id="scan-progress" style="display: none;">
    📂 正在扫描文件: <span id="scan-count">0</span>
  </div>

  <div id="tree-container"></div>
  <p>📦 当前选中文件总大小：<span id="size-display">0 B</span></p>

  <button id="generate-btn" disabled>生成 Markdown</button>
  <button id="copy-btn" disabled>📋 复制到剪贴板</button>
  <button id="export-btn" disabled>💾 导出为 .md 文件</button>

  <div id="generate-progress" style="display: none;">
    ⏳ 正在生成: <span id="generate-status"></span>
  </div>
  
  <textarea id="markdown-output" rows="20" placeholder="Markdown 会显示在这里..."></textarea>

  <script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/jstree@3.3.12/dist/jstree.min.js"></script>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();

      // 状态
      let fileMap = {};          // { path: { size, extension } }
      let selectedPaths = [];
      let allExtensions = new Set();
      let extensionFilters = new Set();
      let projectName = "";

      // 工具函数
      function getExtension(path) {
        const parts = path.split('/');
        const file = parts[parts.length - 1];
        const dotIndex = file.lastIndexOf('.');
        return dotIndex === -1 ? '[无后缀]' : file.substring(dotIndex + 1).toLowerCase();
      }

      function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
      }

      // 渲染后缀过滤器
      function renderExtensionFilters() {
        const container = document.getElementById("extension-filters");
        container.innerHTML = "";
        const sortedExts = Array.from(allExtensions).sort((a, b) => a.localeCompare(b));
        sortedExts.forEach(ext => {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = ext;
          checkbox.checked = extensionFilters.has(ext);
          checkbox.id = \`ext-\${ext}\`;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) extensionFilters.add(ext);
            else extensionFilters.delete(ext);
            applyExtensionFilter();
          });
          const label = document.createElement("label");
          label.htmlFor = checkbox.id;
          label.style.marginRight = "10px";
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(" " + ext));
          container.appendChild(label);
        });
      }

      // 应用后缀筛选
      function applyExtensionFilter() {
        const tree = $('#tree-container').jstree(true);
        if (!tree) return;
        const allFileNodes = $('#tree-container [data-file="true"]');
        allFileNodes.each((_, el) => {
          const nodeId = el.id;
          const ext = getExtension(nodeId);
          const shouldShow = extensionFilters.has(ext);
          if (shouldShow) tree.show_node(nodeId);
          else {
            tree.hide_node(nodeId);
            if (tree.is_selected(nodeId)) tree.deselect_node(nodeId);
          }
        });
        updateSelectedInfo();
      }

      function updateSelectedInfo() {
        const tree = $('#tree-container').jstree(true);
        if (!tree) return;
        const selectedIds = tree.get_selected();
        selectedPaths = selectedIds.filter(id => fileMap[id]);
        const totalBytes = selectedPaths.reduce((sum, path) => sum + (fileMap[path]?.size || 0), 0);
        document.getElementById("size-display").textContent = formatBytes(totalBytes);
        // 启用/禁用按钮
        const generateBtn = document.getElementById('generate-btn');
        const copyBtn = document.getElementById('copy-btn');
        const exportBtn = document.getElementById('export-btn');
        if (selectedPaths.length > 0) {
          generateBtn.disabled = false;
          copyBtn.disabled = false;
          exportBtn.disabled = false;
        } else {
          generateBtn.disabled = true;
          copyBtn.disabled = true;
          exportBtn.disabled = true;
        }
      }

      // 构建树
      function buildTree() {
        const tree = {};
        Object.keys(fileMap).forEach(path => {
          const parts = path.split('/');
          let current = tree;
          parts.forEach((part, idx) => {
            if (!current[part]) current[part] = { __children: {}, __file: null };
            if (idx === parts.length - 1) current[part].__file = true;
            current = current[part].__children;
          });
        });

        const nodes = [];
        const rootId = projectName || '项目';
        nodes.push({ id: rootId, parent: '#', text: rootId + '/', li_attr: { "data-file": "false" } });

        function recurse(obj, parentPath) {
          const sortedEntries = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
            const aIsDir = !aData.__file;
            const bIsDir = !bData.__file;
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
            return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
          });
          sortedEntries.forEach(([name, data]) => {
            const currentPath = parentPath === rootId ? name : \`\${parentPath}/\${name}\`;
            const isFile = !!data.__file;
            nodes.push({
              id: currentPath,
              parent: parentPath,
              text: isFile ? \`\${name} (\${formatBytes(fileMap[currentPath]?.size || 0)})\` : name,
              icon: isFile ? "jstree-file" : undefined,
              li_attr: { "data-file": isFile ? "true" : "false", "data-ext": isFile ? getExtension(currentPath) : "" }
            });
            if (data.__children && Object.keys(data.__children).length > 0) {
              recurse(data.__children, currentPath);
            }
          });
        }
        recurse(tree, rootId);

        $('#tree-container')
          .jstree('destroy')
          .empty()
          .jstree({
            core: { data: nodes, themes: { dots: true, icons: true }, multiple: true },
            plugins: ["checkbox"]
          })
          .on("ready.jstree", function () { applyExtensionFilter(); })
          .on("changed.jstree", function () { updateSelectedInfo(); });
      }

      // 监听来自插件消息
      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
          case 'folderData':
            // 接收文件列表
            projectName = msg.projectName;
            fileMap = {};
            allExtensions.clear();
            extensionFilters.clear();
            msg.files.forEach((f: { path: string; size: number; extension: string }) => {
              fileMap[f.path] = { size: f.size, extension: f.extension };
              allExtensions.add(f.extension);
            });
            extensionFilters = new Set(allExtensions);
            renderExtensionFilters();
            buildTree();
            document.getElementById('scan-progress').style.display = 'none';
            break;

          case 'generateProgress':
            document.getElementById('generate-progress').style.display = 'block';
            document.getElementById('generate-status').textContent = \`(\${msg.current}/\${msg.total}) \${msg.file}\`;
            break;

          case 'markdownResult':
            document.getElementById('generate-progress').style.display = 'none';
            document.getElementById('markdown-output').value = msg.markdown;
            break;
        }
      });

      // 按钮事件
      document.getElementById('pick-folder-btn').addEventListener('click', () => {
        document.getElementById('scan-progress').style.display = 'block';
        document.getElementById('scan-count').textContent = '0';
        vscode.postMessage({ command: 'pickFolder' });
      });

      document.getElementById('generate-btn').addEventListener('click', () => {
        // 敏感词检测（简化，可自行扩展）
        const sensitive = ['.env', 'secret', 'password', 'key', 'token'];
        const hasSensitive = selectedPaths.some(p => sensitive.some(s => p.toLowerCase().includes(s)));
        if (hasSensitive && !confirm('⚠️ 选中的文件可能包含敏感信息，确定生成？')) {
          return;
        }
        document.getElementById('generate-progress').style.display = 'block';
        document.getElementById('generate-status').textContent = '准备中...';
        vscode.postMessage({
          command: 'generateMarkdown',
          selectedPaths: selectedPaths,
          projectName: projectName
        });
      });

      document.getElementById('copy-btn').addEventListener('click', () => {
        const text = document.getElementById('markdown-output').value;
        navigator.clipboard.writeText(text).then(() => {
          alert('✅ 已复制到剪贴板');
        }).catch(() => alert('❌ 复制失败'));
      });

      document.getElementById('export-btn').addEventListener('click', () => {
        const content = document.getElementById('markdown-output').value;
        if (!content.trim()) {
          alert('请先生成 Markdown 内容');
          return;
        }
        vscode.postMessage({
          command: 'exportMarkdown',
          content,
          projectName
        });
      });

      // 初始禁用按钮
      document.getElementById('generate-btn').disabled = true;
      document.getElementById('copy-btn').disabled = true;
      document.getElementById('export-btn').disabled = true;
    })();
  </script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map