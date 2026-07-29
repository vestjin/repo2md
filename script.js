// ==================== 全局状态 ====================
let fileMap = {};          // { relativePath: File }
let selectedPaths = [];    // 当前勾选的文件路径
let allExtensions = new Set();
let extensionFilters = new Set();
let projectName = "";      // 从根目录名称获取
let scanCount = 0;
const MAX_SCAN_DEPTH = 200;          // 最大递归深度
let visitedPaths = new Set();        // 用于检测循环引用
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
  'bin', 'dat', 'db', 'sqlite', 'ico', 'cur', 'icns',
]);
// ==================== 自动过滤规则 ====================
const IGNORE_DIR_NAMES = new Set([
  '.git', '.svn', '.hg',          // 版本控制
  '__pycache__', 'venv', '.venv', '.pytest_cache',           // Python
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
  'pyc', 'pyo', 'pkl', 'db', 'gitignore',                         // Python 字节码
  'class',                                    // Java 字节码
  'log', 'tmp', 'swp', 'swo',                 // 临时文件
  'DS_Store', 'csv', 'md',                                   // macOS 元数据
]);

const IGNORE_FILE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
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

  // 读取前 256 字节用于魔数检测和文本试探
  const headerSize = Math.min(file.size, 256);
  let buffer;
  try {
    buffer = await Promise.race([
      file.slice(0, headerSize).arrayBuffer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('读取头部超时')), 3000))
    ]);
  } catch (err) {
    console.warn(`二进制检测超时，视为二进制: ${path}`);
    return true; // 超时直接当作二进制，跳过内容
  }
  const view = new Uint8Array(buffer);
  
  // ----- 可执行文件魔数检测 -----
  // ELF (Linux/Unix 可执行文件)
  if (view[0] === 0x7F && view[1] === 0x45 && view[2] === 0x4C && view[3] === 0x46) return true;
  // PE/COFF (Windows 可执行文件, .exe/.dll)
  if (view[0] === 0x4D && view[1] === 0x5A) return true;
  // Mach-O (macOS 可执行文件)
  if (view[0] === 0xFE && view[1] === 0xED && view[2] === 0xFA && (view[3] === 0xCE || view[3] === 0xCF)) return true;
  // ----- 保留原有魔数检测 -----
  if (view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46) return true; // PDF
  if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) return true; // PNG
  if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) return true; // JPEG
  if (view[0] === 0x50 && view[1] === 0x4B) return true; // ZIP
  if (view[0] === 0x1F && view[1] === 0x8B) return true; // GZIP

  // ----- 新增：尝试 UTF-8 解码，如果失败则视为二进制 -----
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer.slice(0, 128)); // 解码前128字节
  } catch (e) {
    // 解码失败，说明不是合法的 UTF-8 文本，视为二进制
    return true;
  }

  return false; // 通过所有检测，视为文本
}

// 流式读取文本文件（不阻塞UI）
async function readTextFileStream(file) {
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true }); // 严格模式
  let result = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // decode 可能抛出异常，会被下面的 catch 捕获
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode(); // 完成
  } catch (e) {
    // 重新抛出，让上层知道是解码失败
    throw new Error('文件不是有效的文本文件');
  } finally {
    reader.releaseLock();
  }
  return result;
}

// ==================== 新版文件夹选择 ====================
async function pickDirectoryModern() {
  visitedPaths = new Set();
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

async function walkDirectory(dirHandle, basePath, depth = 0) {
  // 深度保护
  if (depth > MAX_SCAN_DEPTH) {
    console.warn(`⚠️ 达到最大深度限制 (${MAX_SCAN_DEPTH})，跳过: ${basePath}`);
    return;
  }

  // 循环引用检测（基于完整路径）
  const currentPath = basePath || '';
  if (visitedPaths.has(currentPath)) {
    console.warn(`🔄 检测到循环引用，跳过: ${currentPath}`);
    return;
  }
  visitedPaths.add(currentPath);

  let batchCounter = 0;
  const BATCH_SIZE = 50;

  for await (const entry of dirHandle.values()) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    try {
      if (entry.kind === 'directory') {
        if (isIgnored(fullPath, true)) continue;
        // 递归，深度+1
        await walkDirectory(entry, fullPath, depth + 1);
      } else if (entry.kind === 'file') {
        if (isIgnored(fullPath, false)) continue;

        let file;
        try {
          // 超时保护（2秒）
          file = await Promise.race([
            entry.getFile(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`读取超时: ${fullPath}`)), 2000))
          ]);
        } catch (err) {
          console.warn(`⏰ 跳过文件（读取超时）: ${fullPath}`);
          continue;
        }

        // 可选：跳过超大文件（> 50 MB）
        if (file.size > 50 * 1024 * 1024) {
          console.warn(`📦 文件过大，跳过: ${fullPath} (${file.size} bytes)`);
          continue;
        }

        fileMap[fullPath] = file;
        allExtensions.add(getExtension(fullPath));
        scanCount++;
        batchCounter++;

        if (batchCounter % BATCH_SIZE === 0) {
          updateScanProgress(scanCount);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (err) {
      console.warn(`⚠️ 处理 ${fullPath} 时出错:`, err.message);
    }
  }
}

// 辅助函数：更新进度显示
function updateScanProgress(count) {
  const progressEl = document.getElementById('scan-progress');
  const countSpan = document.getElementById('scan-count');
  if (progressEl && countSpan) {
    progressEl.style.display = 'block';
    countSpan.textContent = count;
  }
}

// ==================== 传统文件夹选择 ====================
function handleLegacyPicker(files) {
  visitedPaths = new Set();
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

  // 构建树对象（不变）
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
  const rootId = "__ROOT__";   // ★ 固定根节点ID，避免与文件名冲突

  // 根节点
  nodes.push({
    id: rootId,
    parent: '#',
    text: projectName + '/',
    icon: undefined,
    li_attr: { "data-file": "false", "data-ext": "" }
  });

  // 递归生成子节点
  function recurse(obj, parentPath) {
    const sortedEntries = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    sortedEntries.forEach(([name, data]) => {
      // 当前节点的完整路径：如果父节点是根，则直接使用名称；否则拼接
      const currentPath = parentPath === rootId ? name : `${parentPath}/${name}`;
      const isFile = !!data.__file;

      const node = {
        id: currentPath,
        parent: parentPath,   // 父节点ID为 parentPath（根节点或子目录）
        text: isFile ? `${name} (${formatBytes(data.__file.size)})` : name,
        icon: isFile ? "jstree-file" : undefined,
        li_attr: {
          "data-file": isFile ? "true" : "false",
          "data-ext": isFile ? getExtension(currentPath) : ""
        }
      };
      nodes.push(node);

      if (data.__children && Object.keys(data.__children).length > 0) {
        recurse(data.__children, currentPath);
      }
    });
  }

  // 从树根开始递归，父路径为 rootId
  recurse(tree, rootId);

  // 渲染 jsTree
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
      applyExtensionFilter();
    })
    .on("changed.jstree", function () {
      updateSelectedInfo();
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
        mdParts.push(`### \`${path}\`\n\`\`\`\n[读取失败: ${e.message || '文件可能为二进制或已损坏'}]\n\`\`\``);
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