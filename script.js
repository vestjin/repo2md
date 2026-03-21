// ==================== 全局状态 ====================
let fileMap = {};          // { relativePath: File }
let selectedPaths = [];    // 当前勾选的文件路径
let allExtensions = new Set();
let extensionFilters = new Set();
let projectName = "";      // 从根目录名称获取
let scanCount = 0;
// ==================== 二进制扩展名黑名单 ====================
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
  'mp4', 'mp3', 'avi', 'mov', 'wmv', 'flv',
  'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'docx', 'doc', 
  'zip', 'rar', '7z', 'tar', 'gz',
  'exe', 'dll', 'so', 'dylib',
  'iso', 'img', 'txt',
  'woff', 'woff2', 'ttf', 'eot',
  'psd', 'ai', 'eps', 'pkl', 'db',
  'bin', 'dat', 'db', 'sqlite', 'ico', 'cur', 'icns'
]);
// ==================== 自动过滤规则 ====================
const IGNORE_DIR_NAMES = new Set([
  '.git', '.svn', '.hg',          // 版本控制
  '__pycache__', 'venv', '.venv', '.pytest_cache',                 // Python
  'node_modules',                 // Node.js
  'target',                       // Java / Maven
  'bin', 'obj',                   // C# / C++ 输出
  'build', 'dist',                // 常见构建目录
  '.idea', '.vscode',             // IDE 配置
  'vendor',                       // Go vendor / PHP
  'out',                           // 其他输出
]);

const IGNORE_FILE_EXTENSIONS = new Set([
  'o', 'obj', 'exe', 'dll', 'so', 'dylib',   // 编译产物
  'pyc', 'pyo', 'pkl', 'db', 'gitignore'                             // Python 字节码
  'class',                                    // Java 字节码
  'log', 'tmp', 'swp', 'swo',                 // 临时文件
  'DS_Store', 'csv', 'md',                                   // macOS 元数据
]);

const IGNORE_FILE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini'
]);

// ==================== 工具函数 ====================
/**
 * 判断文件或目录是否应被自动过滤
 * @param {string} relativePath 相对路径（如 "src/main.js" 或 "node_modules/..."）
 * @param {boolean} isDirectory 是否为目录
 * @returns {boolean} true 表示忽略
 */
function isIgnored(relativePath, isDirectory = false) {
  const parts = relativePath.split('/');
  // 检查每个路径组件（目录名）是否在忽略目录列表中
  for (let i = 0; i < parts.length; i++) {
    if (IGNORE_DIR_NAMES.has(parts[i])) {
      return true;
    }
  }
  // 文件：额外检查文件名与扩展名
  if (!isDirectory) {
    const fileName = parts[parts.length - 1];
    if (IGNORE_FILE_NAMES.has(fileName)) return true;
    const dotIdx = fileName.lastIndexOf('.');
    if (dotIdx !== -1) {
      const ext = fileName.substring(dotIdx + 1).toLowerCase();
      if (IGNORE_FILE_EXTENSIONS.has(ext)) return true;
    }
  }
  return false;
}
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

// 二进制文件快速检测（扩展名 + 魔数）
async function isBinaryFile(file, path) {
  const ext = getExtension(path);
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // 读取前4个字节检查常见二进制魔数
  try {
    const header = await file.slice(0, 4).arrayBuffer();
    const view = new Uint8Array(header);
    // PDF: %PDF
    if (view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46) return true;
    // PNG: �PNG
    if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) return true;
    // JPEG: ����
    if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) return true;
    // ZIP (PK)
    if (view[0] === 0x50 && view[1] === 0x4B) return true;
    // GZIP
    if (view[0] === 0x1F && view[1] === 0x8B) return true;
  } catch (e) {
    // 读取失败则保守认为是二进制
    return true;
  }
  return false;
}

// 流式读取文本文件（不阻塞UI）
async function readTextFileStream(file) {
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      // 主动让出主线程，每块处理后可取消注释以提升响应性
      // await new Promise(resolve => setTimeout(resolve, 0));
    }
    result += decoder.decode(); // 完成
  } finally {
    reader.releaseLock();
  }
  return result;
}

// ==================== 新版文件夹选择 ====================
async function pickDirectoryModern() {
  if (!('showDirectoryPicker' in window)) {
    alert('您的浏览器不支持新版文件夹选择，已自动切换到传统模式。');
    return;
  }

  // 重置进度
  scanCount = 0;
  const progressEl = document.getElementById('scan-progress');
  if (progressEl) progressEl.style.display = 'block';
  document.getElementById('scan-count').textContent = '0';

  try {
    const dirHandle = await window.showDirectoryPicker();
    projectName = dirHandle.name;
    fileMap = {};
    allExtensions.clear();
    extensionFilters.clear();

    await walkDirectory(dirHandle, '');

    // 隐藏进度
    if (progressEl) progressEl.style.display = 'none';

    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree();
  } catch (err) {
    // 错误时也隐藏进度条
    if (progressEl) progressEl.style.display = 'none';
    if (err.name === 'AbortError') return;
    console.error(err);
    alert('读取文件夹失败：' + err.message);
  }
}

async function walkDirectory(dirHandle, basePath) {
  for await (const entry of dirHandle.values()) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.kind === 'directory') {
      // 目录过滤：如果目录名在忽略列表中，直接跳过该目录
      if (isIgnored(fullPath, true)) {
        continue;
      }
      // 递归遍历子目录
      await walkDirectory(entry, fullPath);
    } else if (entry.kind === 'file') {
      // 文件过滤
      if (isIgnored(fullPath, false)) {
        continue;
      }

      const file = await entry.getFile();
      fileMap[fullPath] = file;

      const ext = getExtension(fullPath);
      allExtensions.add(ext);

      // 更新扫描进度
      scanCount++;
      const progressEl = document.getElementById('scan-progress');
      const countSpan = document.getElementById('scan-count');
      if (progressEl && countSpan) {
        progressEl.style.display = 'block';
        countSpan.textContent = scanCount;
        // 主动让出主线程，避免长时间阻塞渲染
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
}

// ==================== 传统文件夹选择 ====================
function handleLegacyPicker(files) {
  scanCount = 0;
  const progressEl = document.getElementById('scan-progress');
  if (progressEl) progressEl.style.display = 'block';
  document.getElementById('scan-count').textContent = '0';

  fileMap = {};
  allExtensions.clear();
  extensionFilters.clear();

  if (files.length > 0) {
    const firstPath = files[0].webkitRelativePath || files[0].name;
    projectName = firstPath.split('/')[0] || 'untitled';
  }

  Array.from(files).forEach(file => {
    const relativePath = file.webkitRelativePath || file.name;
    fileMap[relativePath] = file;
    const ext = getExtension(relativePath);
    allExtensions.add(ext);

    scanCount++;
    document.getElementById('scan-count').textContent = scanCount;  
  });

  if (progressEl) progressEl.style.display = 'none';

  extensionFilters = new Set(allExtensions);
  renderExtensionFilters();
  buildTree();
}

// ==================== 后缀筛选UI ====================
function renderExtensionFilters() {
  const container = document.getElementById("extension-filters");
  container.innerHTML = "";

  const sortedExts = Array.from(allExtensions).sort((a, b) => a.localeCompare(b));
  sortedExts.forEach(ext => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = ext;
    checkbox.checked = extensionFilters.has(ext);
    checkbox.id = `ext-${ext}`;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        extensionFilters.add(ext);
      } else {
        extensionFilters.delete(ext);
      }
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

// ==================== 快速后缀筛选 ====================
function applyExtensionFilter() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  const allFileNodes = $('#tree-container [data-file="true"]');

  allFileNodes.each((_, el) => {
    const nodeId = el.id;
    const ext = getExtension(nodeId);
    const shouldShow = extensionFilters.has(ext);

    if (shouldShow) {
      tree.show_node(nodeId);
    } else {
      tree.hide_node(nodeId);
      if (tree.is_selected(nodeId)) {
        tree.deselect_node(nodeId);
      }
    }
  });

  updateSelectedInfo();
}

function updateSelectedInfo() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  const selectedIds = tree.get_selected();
  selectedPaths = selectedIds.filter(id => fileMap[id]);

  const totalBytes = selectedPaths.reduce((sum, path) => sum + fileMap[path].size, 0);
  document.getElementById("size-display").textContent = formatBytes(totalBytes);
}

// ==================== 构建文件树（包含项目根目录）====================
function buildTree() {
  const tree = {};

  // 所有文件全部加入树（不按后缀过滤）
  Object.entries(fileMap).forEach(([path, file]) => {
    const parts = path.split('/');
    let current = tree;

    parts.forEach((part, idx) => {
      if (!current[part]) {
        current[part] = { __children: {}, __file: null };
      }
      if (idx === parts.length - 1) {
        current[part].__file = file;
      }
      current = current[part].__children;
    });
  });

  const nodes = [];
  // 根节点 ID 使用项目名，若为空则使用默认名
  const rootId = projectName || '项目';

  // 1. 添加根节点
  nodes.push({
    id: rootId,
    parent: '#',
    text: rootId + '/',        // 显示为 项目名/
    icon: undefined,            // 可自定义文件夹图标，留空则使用默认
    li_attr: {
      "data-file": "false",     // 标记为非文件
      "data-ext": ""
    }
  });

  // 2. 递归生成子节点
  function recurse(obj, parentPath) {
    // 排序：目录优先 + 字母序
    const sortedEntries = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    sortedEntries.forEach(([name, data]) => {
      // 当前节点的完整路径：如果父节点是根，则路径为 name；否则为 parentPath/name
      const currentPath = parentPath === rootId ? name : `${parentPath}/${name}`;
      const isFile = !!data.__file;

      const node = {
        id: currentPath,
        parent: parentPath,
        text: isFile ? `${name} (${formatBytes(data.__file.size)})` : name,
        icon: isFile ? "jstree-file" : undefined,
        li_attr: {
          "data-file": isFile ? "true" : "false",
          "data-ext": isFile ? getExtension(currentPath) : ""
        }
      };
      nodes.push(node);

      // 递归处理子目录
      if (data.__children && Object.keys(data.__children).length > 0) {
        recurse(data.__children, currentPath);
      }
    });
  }

  // 从根节点开始递归，传入根节点 ID 作为父路径
  recurse(tree, rootId);

  // 3. 渲染 jsTree
  $('#tree-container')
    .jstree('destroy')
    .empty()
    .jstree({
      core: {
        data: nodes,
        themes: { dots: true, icons: true },
        multiple: true
      },
      plugins: ["checkbox"]
    })
    .on("ready.jstree", function () {
      applyExtensionFilter();   // 应用后缀筛选（隐藏不符合的文件）
    })
    .on("changed.jstree", function () {
      updateSelectedInfo();     // 更新总大小
    });
}

// ==================== 生成 ASCII 目录树（基于已勾选文件）====================
function generateDirectoryTree() {
  // 1. 根据 selectedPaths 构建树对象
  const filteredTree = {};

  selectedPaths.forEach(path => {
    const parts = path.split('/');
    let current = filteredTree;

    parts.forEach((part, idx) => {
      if (!current[part]) {
        current[part] = { __children: {} };
      }
      if (idx === parts.length - 1) {
        // 标记为文件（只需布尔值，不需要真实 File 对象）
        current[part].__file = true;
      }
      current = current[part].__children;
    });
  });

  // 2. 递归生成树字符串（目录优先 + 字母序）
  function buildTreeString(node, prefix = '', isLast = true) {
    if (Object.keys(node).length === 0) return '';

    const entries = Object.entries(node).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    let result = '';
    entries.forEach(([name, data], index) => {
      const isLastEntry = index === entries.length - 1;
      const hasChildren = Object.keys(data.__children || {}).length > 0;
      const isFile = !!data.__file;

      // 当前行
      result += prefix + (isLast ? '└── ' : '├── ') + name;
      if (!isFile && hasChildren) result += '/';
      result += '\n';

      // 递归子节点
      if (hasChildren) {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        result += buildTreeString(data.__children, childPrefix, isLastEntry);
      }
    });
    return result;
  }

  // 3. 根目录 + 内容
  let treeString = `${projectName || '项目'}/\n`;
  if (selectedPaths.length === 0) {
    treeString += '└── (无选中文件)\n';
  } else {
    treeString += buildTreeString(filteredTree, '', true);
  }
  return treeString;
}

// ==================== 生成 Markdown（包含目录树 + 选中文件内容）====================
async function generateMarkdown() {
  let mdParts = [];
  const progressEl = document.getElementById('generate-progress');
  const statusSpan = document.getElementById('generate-status');
  // 显示进度
  if (progressEl) progressEl.style.display = 'block';
  // 1. 项目概览标题
  mdParts.push(`# 项目概览：${projectName || 'untitled'}\n`);

  // 2. 目录树
  mdParts.push(`## 📁 目录结构\n`);
  mdParts.push('```\n' + generateDirectoryTree() + '```\n');

  // 3. 文件内容
  if (selectedPaths.length === 0) {
    mdParts.push('*(未选中任何文件)*');
  } else {
    mdParts.push(`## 📄 文件内容\n`);

    const total = selectedPaths.length;
    for (let i = 0; i < total; i++) {
      const path = selectedPaths[i];
      const file = fileMap[path];
      const ext = getExtension(path);

      // 更新进度
      if (statusSpan) {
        statusSpan.textContent = `(${i+1}/${total}) ${path}`;
      }
      // 让UI更新
      await new Promise(resolve => setTimeout(resolve, 0));

      // 二进制文件检测
      const binary = await isBinaryFile(file, path);
      if (binary) {
        mdParts.push(`### \`${path}\`\n\`\`\`\n[二进制文件，已跳过]\n\`\`\``);
        continue;
      }

      // 文本文件 - 流式读取
      try {
        const content = await readTextFileStream(file);
        mdParts.push(`### \`${path}\`\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
      } catch (e) {
        mdParts.push(`### \`${path}\`\n\`\`\`\n[读取失败: ${e.message || '未知错误'}]\n\`\`\``);
      }
    }
  }

  // 隐藏进度
  if (progressEl) progressEl.style.display = 'none';

  return mdParts.join('\n\n');
}

// ==================== 导出 .md 文件 ====================
function downloadMarkdown(content, name) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `${name || 'project'}_${date}.md`;
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// 敏感词列表（可扩展）
const SENSITIVE_KEYWORDS = [
  '.env', '.key', '.pem', 'id_rsa', 'id_dsa',
  'password', 'secret', 'token', 'credential', 'aws', 'private'
];
function hasSensitiveFiles(paths) {
  return paths.some(path => {
    const lower = path.toLowerCase();
    return SENSITIVE_KEYWORDS.some(keyword => lower.includes(keyword));
  });
}

// ==================== 事件绑定 ====================
function initUI() {
  // 文件夹选择
  const modernBtn = document.getElementById('modern-picker-btn');
  const legacyLabel = document.getElementById('legacy-picker-label');
  const legacyInput = document.getElementById('directory-picker');

  if ('showDirectoryPicker' in window) {
    modernBtn.style.display = 'block';
    legacyLabel.style.display = 'none';
    modernBtn.addEventListener('click', pickDirectoryModern);
  } else {
    modernBtn.style.display = 'none';
    legacyLabel.style.display = 'block';
    legacyInput.addEventListener('change', (e) => {
      handleLegacyPicker(e.target.files);
    });
  }

  // 生成 Markdown
  document.getElementById('generate-btn').addEventListener('click', async () => {
    if (hasSensitiveFiles(selectedPaths)) {
      const confirm = window.confirm(
        '⚠️ 您选中的文件中可能包含敏感信息（如密钥、密码等）。\n确定要生成 Markdown 吗？'
      );
      if (!confirm) return;
    }
    
    const generateBtn = document.getElementById('generate-btn');
    generateBtn.disabled = true;
    generateBtn.textContent = '⏳ 生成中...';
    try {
      const markdown = await generateMarkdown();
      document.getElementById('markdown-output').value = markdown;
    } catch (e) {
      console.error(e);
      alert('生成失败：' + e.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = '生成 Markdown';
    }
  });

  // 复制到剪贴板
  document.getElementById('copy-btn').addEventListener('click', () => {
    const text = document.getElementById('markdown-output').value;
    navigator.clipboard.writeText(text).then(() => {
      alert('✅ 已复制到剪贴板');
    }).catch(() => {
      alert('❌ 复制失败，请手动复制');
    });
  });

  // 导出为 .md 文件
  document.getElementById('export-btn').addEventListener('click', () => {
    const content = document.getElementById('markdown-output').value;
    if (!content.trim()) {
      alert('请先生成 Markdown 内容');
      return;
    }
    downloadMarkdown(content, projectName);
  });
}

// 启动
initUI();