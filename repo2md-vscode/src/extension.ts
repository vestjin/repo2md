import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

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
// 默认忽略的目录名（涵盖常见构建输出、依赖、版本控制、IDE配置、缓存等）
const IGNORED_DIRECTORIES = new Set([
  // 版本控制
  '.git', '.svn', '.hg', '.cvs',

  // 依赖包
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'composer', 'packages',

  // 构建输出
  'out', 'dist', 'build', 'target', 'bin', 'obj', 'output', 'release', 'debug',

  // 缓存和临时文件
  'cache', '.cache', 'tmp', 'temp', 'logs', 'log', 'coverage', '.nyc_output',
  '.parcel-cache', '.cache-loader', '.serverless', '.serverless_nextjs',
  '.pytest_cache', '.mypy_cache', '.ipynb_checkpoints', '.sass-cache',
  '.scannerwork', '.sonar', '.trunk', '.docusaurus', '.expo',

  // IDE配置
  '.vscode', '.idea', '.vs', '.history', '.settings', '.project', '.classpath',
  '.factorypath', '.recommenders', '.sts4-cache', '.vertx', '.mvn',

  // 框架/工具特定
  '.next', '.nuxt', '.output', '.vercel', '.netlify', '.now', '.cache',
  '.dart_tool', '.packages', '.pub-cache', '.gradle', '.m2', '.ivy2',
  '.terraform', '.serverless', '.serverless_nextjs',

  // 其他常见忽略项
  '.venv', 'venv', 'env',      // Python虚拟环境
  '__pycache__',               // Python字节码缓存
  '.pytest_cache', '.mypy_cache', '.hypothesis', // Python测试缓存
  '.spyderproject', '.spyproject', '.ropeproject', // Python IDE
  '.dart_tool', '.flutter-plugins', '.flutter-plugins-dependencies', // Flutter
  '.history', '.backup',       // 备份文件目录
  '.trash', '.recycle',        // 回收站
  'coverage', '.nyc_output',   // 测试覆盖率
]);

// 获取文件扩展名
function getExtension(filePath: string): string {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1];
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex === -1 ? '[无后缀]' : fileName.substring(dotIndex + 1).toLowerCase();
}

// 检测二进制文件（扩展名 + 魔数）
async function isBinaryFile(filePath: string): Promise<boolean> {
  const ext = getExtension(filePath);
  if (BINARY_EXTENSIONS.has(ext)) return true;

  try {
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buffer, 0, 4, 0);
    await fd.close();

    if (bytesRead < 4) return false;

    // 常见魔数判断
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return true; // PDF
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true; // PNG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true; // JPEG
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return true; // ZIP
    if (buffer[0] === 0x1F && buffer[1] === 0x8B) return true; // GZIP
  } catch {
    return true; // 读取失败也视为二进制
  }
  return false;
}

// 递归读取文件夹，返回文件信息列表
async function readDirectoryRecursive(dirPath: string, basePath: string): Promise<Array<{ path: string; size: number }>> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: Array<{ path: string; size: number }> = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      // 跳过忽略的目录
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const subResults = await readDirectoryRecursive(fullPath, basePath);
      results.push(...subResults);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      results.push({ path: relativePath, size: stat.size });
    }
  }
  return results;
}

// 格式化字节
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 生成 ASCII 目录树
function generateDirectoryTree(files: string[], rootName: string): string {
  const tree: any = {};
  files.forEach(filePath => {
    const parts = filePath.split('/');
    let current = tree;
    parts.forEach((part, idx) => {
      if (!current[part]) current[part] = { __children: {} };
      if (idx === parts.length - 1) current[part].__file = true;
      current = current[part].__children;
    });
  });

  function buildTreeString(node: any, prefix = '', isLast = true): string {
    const entries = Object.entries(node).sort(([aName, aData]: any, [bName, bData]: any) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    let result = '';
    entries.forEach(([name, data]: any, index) => {
      const isLastEntry = index === entries.length - 1;
      const hasChildren = Object.keys(data.__children || {}).length > 0;
      const isFile = !!data.__file;

      result += prefix + (isLast ? '└── ' : '├── ') + name;
      if (!isFile && hasChildren) result += '/';
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
  } else {
    treeString += buildTreeString(tree, '', true);
  }
  return treeString;
}

// 读取文件内容（文本）
async function readTextFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf-8');
}

export function activate(context: vscode.ExtensionContext) {
  const command = vscode.commands.registerCommand('repo2md.start', async () => {
    // 检查是否有打开的工作区
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('请先打开一个文件夹或工作区');
      return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const projectName = path.basename(rootPath);

    // 创建 Webview 面板
    const panel = vscode.window.createWebviewPanel(
      'repo2md',
      'Repo to Markdown',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    panel.webview.html = getWebviewContent();

    // 当前文件列表（用于生成时）
    let currentFiles: Array<{ path: string; size: number }> = [];

    // 防抖定时器
    let refreshTimer: NodeJS.Timeout | undefined;

    // 刷新函数：重新扫描并发送更新
    const refreshFiles = async () => {
      try {
        currentFiles = await readDirectoryRecursive(rootPath, rootPath);
        const fileList = currentFiles.map(f => ({
          path: f.path,
          size: f.size,
          extension: getExtension(f.path)
        }));
        panel.webview.postMessage({
          command: 'folderData',
          projectName,
          files: fileList
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(`自动刷新失败: ${err.message}`);
      }
    };

    // 创建文件监听器
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootPath, '**/*')
    );

    // 监听所有文件变动事件，防抖后刷新
    const debouncedRefresh = () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(refreshFiles, 500); // 500ms 防抖
    };

    watcher.onDidChange(debouncedRefresh);
    watcher.onDidCreate(debouncedRefresh);
    watcher.onDidDelete(debouncedRefresh);

    // 面板关闭时清理监听器和定时器
    panel.onDidDispose(() => {
      watcher.dispose();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    });

    // 处理来自 Webview 的消息
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready':
          // Webview 已准备好，开始扫描
          try {
            await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `扫描项目 ${projectName} 中...`,
              cancellable: false
            }, async (progress) => {
              currentFiles = await readDirectoryRecursive(rootPath, rootPath);
              const fileList = currentFiles.map(f => ({
                path: f.path,
                size: f.size,
                extension: getExtension(f.path)
              }));
              panel.webview.postMessage({
                command: 'folderData',
                projectName,
                files: fileList
              });
            });
          } catch (err: any) {
            vscode.window.showErrorMessage(`扫描失败: ${err.message}`);
          }
          break;

        case 'generateMarkdown':
          {
            const selectedPaths: string[] = message.selectedPaths;
            if (selectedPaths.length === 0) {
              vscode.window.showWarningMessage('未选中任何文件');
              return;
            }

            // 生成 Markdown
            const mdParts: string[] = [];
            mdParts.push(`# 项目概览：${projectName}\n`);
            mdParts.push(`## 📁 目录结构\n`);
            mdParts.push('```\n' + generateDirectoryTree(selectedPaths, projectName) + '```\n');

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
                } else {
                  const content = await readTextFile(fullPath);
                  mdParts.push(`### \`${relPath}\`\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
                }
              } catch (err: any) {
                mdParts.push(`### \`${relPath}\`\n\`\`\`\n[读取失败: ${err.message}]\n\`\`\``);
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

            const defaultName = projectName || 'project';
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

export function deactivate() {}

// 生成 Webview HTML（内联 JS/CSS）
function getWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Repo to Markdown</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/jstree@3.3.12/dist/themes/default/style.min.css">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 1rem; }
    textarea {
        width: 100%;
        margin-top: 1rem;
        padding: 0.5rem;
        border: 1px solid var(--vscode-input-border, #ccc);
        border-radius: 4px;
        font-family: monospace;
        background-color: var(--vscode-input-background, #ffffff);
        color: var(--vscode-input-foreground, #000000);
        resize: vertical;
    }
    textarea:focus {
        outline: none;
        border-color: var(--vscode-focusBorder, #007acc);
    }
    .project-info {
        font-size: 1.2rem;
        margin-bottom: 1rem;
        padding: 0.5rem 1rem;
        background-color: var(--vscode-badge-background, #f0f0f0);
        color: var(--vscode-badge-foreground, #333);
        border-radius: 4px;
        border: 1px solid var(--vscode-widget-border, transparent);
    }
    button { padding: 0.5rem 1rem; margin: 0.5rem 0.5rem 0.5rem 0; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background-color: #218838; }
    button:disabled { background-color: #6c757d; cursor: not-allowed; }
    #extension-filters label { margin-right: 1rem; font-size: 0.9rem; }
    #tree-container { margin: 1rem 0; border: 1px solid #ddd; padding: 1rem; border-radius: 4px; max-height: 400px; overflow: auto; }
    #scan-progress, #generate-progress { margin: 10px 0; padding: 8px; background: #f0f0f0; border-radius: 4px; }
    #generate-progress {
        background: var(--vscode-editor-inactiveSelectionBackground, #e3f2fd);
    }
    /* 使用 VSCode 主题变量优化 jsTree 选中项和悬停项的可读性 */
    .jstree-default .jstree-clicked {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
        border-radius: 0;
    }
    .jstree-default .jstree-hovered {
        background: var(--vscode-list-hoverBackground) !important;
        color: var(--vscode-list-hoverForeground) !important;
    }
    /* 可选：调整复选框颜色（一般无需修改，但可以保证一致性） */
    .jstree-default .jstree-checkbox {
        /* 保持默认或根据需要调整 */
    }
  </style>
</head>
<body>
  <h1>📘 项目转 Markdown</h1>

  <div class="project-info">
      <span id="project-name">正在加载项目...</span>
  </div>

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
      let prevSelected = [];

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

      // 恢复之前的选中状态（在刷新后）
      function restoreSelected() {
          const tree = $('#tree-container').jstree(true);
          if (!tree) return;
          const toSelect = prevSelected.filter(path => fileMap[path]);
          if (toSelect.length > 0) {
              tree.select_node(toSelect);
          }
          prevSelected = []; // 清空缓存，避免重复恢复
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
          .on("ready.jstree", function () { 
              applyExtensionFilter(); 
              restoreSelected(); 
          })
          .on("changed.jstree", function () { updateSelectedInfo(); });
      }

      // 监听来自插件消息
      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
          case 'folderData':
            // 在重建之前保存当前选中状态
            prevSelected = selectedPaths;
            // 接收文件列表
            projectName = msg.projectName;
            document.getElementById('project-name').textContent = \`项目: \${projectName}\`;
            fileMap = {};
            allExtensions.clear();
            extensionFilters.clear();
            msg.files.forEach((f) => {
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

      // 通知插件 Webview 已准备好
      vscode.postMessage({ command: 'ready' });

      // 按钮事件
      document.getElementById('generate-btn').addEventListener('click', () => {
        // 敏感词检测（简化）
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