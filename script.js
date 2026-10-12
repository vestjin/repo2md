// ==================== 全局状态 ====================
let fileMap = {};
let selectedPaths = [];
let allExtensions = new Set();
let extensionFilters = new Set();
let projectName = "";
let scanCount = 0;
const MAX_SCAN_DEPTH = 200;
const BATCH_SIZE = 50;
let visitedPaths = new Set();

// ==================== 二进制扩展名黑名单 ====================
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
  'mp4', 'mp3', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'doc', 'docx',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  'exe', 'dll', 'so', 'dylib', 'iso', 'img', 'dmg',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'psd', 'ai', 'eps', 'sketch',
  'bin', 'dat', 'db', 'sqlite', 'cur', 'icns',
  'jar', 'war', 'class'
]);

// ==================== 敏感词列表 ====================
const SENSITIVE_KEYWORDS = [
  '.env', '.key', '.pem', 'id_rsa', 'id_dsa', 'id_ed25519',
  'password', 'secret', 'token', 'credential', 'aws', 'private',
  'config.local', '.npmrc', '.gitconfig'
];

// ==================== 自动过滤规则 ====================
const IGNORE_DIR_NAMES = new Set([
  '.git', '.svn', '.hg',
  '__pycache__', 'venv', '.venv', '.pytest_cache',
  'node_modules', 'target', 'bin', 'obj',
  'build', 'dist', '.idea', '.vscode', 'vendor', 'out'
]);

const IGNORE_FILE_EXTENSIONS = new Set([
  'o', 'obj', 'exe', 'dll', 'so', 'dylib',
  'pyc', 'pyo', 'pkl', 'db', 'class',
  'log', 'tmp', 'swp', 'swo', 'csv'
]);

const IGNORE_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// ==================== 工具函数 ====================
function isIgnored(relativePath, isDirectory = false) {
  const parts = relativePath.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (IGNORE_DIR_NAMES.has(parts[i])) return true;
  }
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
  const file = path.split('/').pop();
  const dotIndex = file.lastIndexOf('.');
  return dotIndex === -1 ? '[无后缀]' : file.substring(dotIndex + 1).toLowerCase();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function updateScanProgress(count) {
  const el = document.getElementById('scan-progress');
  const span = document.getElementById('scan-count');
  if (el && span) {
    el.hidden = false;
    span.textContent = count;
  }
}

function resetState() {
  fileMap = {};
  selectedPaths = [];
  allExtensions.clear();
  extensionFilters.clear();
  visitedPaths = new Set();
  scanCount = 0;
}

// ==================== 二进制文件检测 ====================
async function isBinaryFile(file, path) {
  if (BINARY_EXTENSIONS.has(getExtension(path))) return true;

  const headerSize = Math.min(file.size, 256);
  let buffer;
  try {
    buffer = await Promise.race([
      file.slice(0, headerSize).arrayBuffer(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('读取头部超时')), 3000))
    ]);
  } catch (err) {
    return true;
  }
  const view = new Uint8Array(buffer);

  if (view[0] === 0x7F && view[1] === 0x45 && view[2] === 0x4C && view[3] === 0x46) return true;
  if (view[0] === 0x4D && view[1] === 0x5A) return true;
  if (view[0] === 0xFE && view[1] === 0xED && view[2] === 0xFA) return true;
  if (view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46) return true;
  if (view[0] === 0x89 && view[1] === 0x50) return true;
  if (view[0] === 0xFF && view[1] === 0xD8) return true;
  if (view[0] === 0x50 && view[1] === 0x4B) return true;
  if (view[0] === 0x1F && view[1] === 0x8B) return true;

  for (let i = 0; i < view.length; i++) {
    if (view[i] === 0) return true;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.slice(0, 128));
  } catch (e) {
    return true;
  }
  return false;
}

// ==================== 流式读取文本文件 ====================
async function readTextFileStream(file) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
  } catch (e) {
    throw new Error('文件不是有效的文本文件');
  } finally {
    reader.releaseLock();
  }
  return result;
}

// ==================== Tar 解析器 ====================
class TarParser {
  static parse(buffer) {
    const files = [];
    const view = new Uint8Array(buffer);
    let offset = 0;

    while (offset < view.length - 512) {
      const header = view.slice(offset, offset + 512);

      let isEmpty = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { isEmpty = false; break; }
      }
      if (isEmpty) break;

      const nameBytes = header.slice(0, 100);
      let nameEnd = 0;
      while (nameEnd < 100 && nameBytes[nameEnd] !== 0) nameEnd++;
      let name = new TextDecoder().decode(nameBytes.slice(0, nameEnd));

      const prefixBytes = header.slice(345, 500);
      let prefixEnd = 0;
      while (prefixEnd < 155 && prefixBytes[prefixEnd] !== 0) prefixEnd++;
      const prefix = new TextDecoder().decode(prefixBytes.slice(0, prefixEnd));
      if (prefix) name = prefix + '/' + name;

      let sizeStr = '';
      for (let i = 124; i < 136; i++) {
        if (header[i] === 0 || header[i] === 32) continue;
        sizeStr += String.fromCharCode(header[i]);
      }
      const size = parseInt(sizeStr, 8) || 0;

      const typeFlag = header[156];
      const isDir = typeFlag === 53 || typeFlag === 0x35;

      offset += 512;

      if (!isDir && name && size > 0) {
        files.push({
          name: name.replace(/^\.\//, ''),
          content: view.slice(offset, offset + size),
          size: size
        });
      }
      offset += Math.ceil(size / 512) * 512;
    }
    return files;
  }
}

// ==================== 多格式解压 ====================
async function extractArchive(file) {
  const filename = file.name.toLowerCase();
  const ext = filename.split('.').pop();
  let files = [];

  if (ext === 'zip') {
    const zip = await JSZip.loadAsync(file);
    const promises = [];
    zip.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir) {
        promises.push(
          zipEntry.async('uint8array').then(content => {
            files.push({ name: relativePath, content: content, size: content.length });
          })
        );
      }
    });
    await Promise.all(promises);
  } else if (ext === 'tar') {
    files = TarParser.parse(await file.arrayBuffer());
  } else if (ext === 'gz' || ext === 'tgz' || filename.endsWith('.tar.gz')) {
    const decompressed = pako.ungzip(new Uint8Array(await file.arrayBuffer()));
    files = TarParser.parse(decompressed.buffer);
  } else {
    throw new Error('不支持的压缩格式');
  }
  return files;
}

// ==================== 处理压缩包上传 ====================
async function handleArchiveUpload(file) {
  resetState();

  const progressEl = document.getElementById('archive-progress');
  progressEl.hidden = false;
  document.getElementById('extract-count').textContent = '0';

  try {
    const files = await extractArchive(file);

    let candidateName = '';
    if (files.length > 0) {
      candidateName = files[0].name.split('/')[0];
    }
    let useCandidate = !!candidateName;
    if (useCandidate) {
      for (const f of files) {
        if (!f.name.startsWith(candidateName + '/') && f.name !== candidateName) {
          useCandidate = false;
          break;
        }
      }
    }

    projectName = useCandidate
      ? candidateName
      : file.name.replace(/\.(zip|tar|gz|tgz|tar\.gz)$/i, '');

    for (const [index, extractedFile] of files.entries()) {
      let relativePath = extractedFile.name;
      if (relativePath.startsWith(projectName + '/')) {
        relativePath = relativePath.substring(projectName.length + 1);
      }
      if (!relativePath || isIgnored(relativePath, false)) continue;

      const blob = new Blob([extractedFile.content]);
      const fileObj = new File([blob], relativePath.split('/').pop(), {
        lastModified: Date.now(),
        type: 'application/octet-stream'
      });
      fileObj.size = extractedFile.size;
      fileMap[relativePath] = fileObj;
      allExtensions.add(getExtension(relativePath));
      scanCount++;

      if (index % BATCH_SIZE === 0 || index === files.length - 1) {
        document.getElementById('extract-count').textContent = scanCount;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    progressEl.hidden = true;
    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree();
    alert('✅ 解压成功，共 ' + scanCount + ' 个文件');
  } catch (error) {
    progressEl.hidden = true;
    console.error(error);
    alert('❌ 解压失败：' + error.message);
  }
}

// ==================== 新版文件夹选择 ====================
async function pickDirectoryModern() {
  if (!('showDirectoryPicker' in window)) {
    document.getElementById('directory-picker').click();
    return;
  }

  resetState();
  const progressEl = document.getElementById('scan-progress');
  progressEl.hidden = false;
  document.getElementById('scan-count').textContent = '0';

  try {
    const dirHandle = await window.showDirectoryPicker();
    projectName = dirHandle.name;

    await walkDirectory(dirHandle, '');

    progressEl.hidden = true;
    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree();
  } catch (err) {
    progressEl.hidden = true;
    if (err.name === 'AbortError') return;
    console.error(err);
    alert('读取文件夹失败：' + err.message);
  }
}

async function walkDirectory(dirHandle, basePath, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) {
    console.warn('达到最大深度限制，跳过: ' + basePath);
    return;
  }

  const currentPath = basePath || '';
  if (visitedPaths.has(currentPath)) return;
  visitedPaths.add(currentPath);

  let batchCounter = 0;
  for await (const entry of dirHandle.values()) {
    const fullPath = basePath ? basePath + '/' + entry.name : entry.name;
    try {
      if (entry.kind === 'directory') {
        if (isIgnored(fullPath, true)) continue;
        await walkDirectory(entry, fullPath, depth + 1);
      } else if (entry.kind === 'file') {
        if (isIgnored(fullPath, false)) continue;

        let file;
        try {
          file = await Promise.race([
            entry.getFile(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('读取超时')), 2000))
          ]);
        } catch (err) {
          continue;
        }

        if (file.size > 50 * 1024 * 1024) continue;

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
      console.warn('处理 ' + fullPath + ' 时出错:', err.message);
    }
  }
}

// ==================== 传统文件夹选择 ====================
function handleLegacyPicker(files) {
  resetState();

  const progressEl = document.getElementById('scan-progress');
  progressEl.hidden = false;
  document.getElementById('scan-count').textContent = '0';

  if (files.length > 0) {
    const firstPath = files[0].webkitRelativePath || files[0].name;
    projectName = firstPath.split('/')[0] || 'untitled';
  }

  Array.from(files).forEach(file => {
    let relativePath = file.webkitRelativePath || file.name;
    if (relativePath.startsWith(projectName + '/')) {
      relativePath = relativePath.substring(projectName.length + 1);
    }
    if (!relativePath || isIgnored(relativePath, false)) return;

    fileMap[relativePath] = file;
    allExtensions.add(getExtension(relativePath));
    scanCount++;
  });

  progressEl.hidden = true;
  updateScanProgress(scanCount);
  extensionFilters = new Set(allExtensions);
  renderExtensionFilters();
  buildTree();
}

// ==================== 拖拽：FileSystemEntry 递归 ====================
async function walkFileSystemEntry(entry, basePath, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;

  const fullPath = basePath ? basePath + '/' + entry.name : entry.name;

  if (entry.isDirectory) {
    if (isIgnored(fullPath, true)) return;

    const reader = entry.createReader();
    const children = await new Promise((resolve, reject) => {
      const all = [];
      const readBatch = () => {
        reader.readEntries(
          results => {
            if (results.length === 0) resolve(all);
            else { all.push(...results); readBatch(); }
          },
          reject
        );
      };
      readBatch();
    });

    for (const child of children) {
      await walkFileSystemEntry(child, fullPath, depth + 1);
    }
  } else if (entry.isFile) {
    if (isIgnored(fullPath, false)) return;

    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (file.size > 50 * 1024 * 1024) return;

    fileMap[fullPath] = file;
    allExtensions.add(getExtension(fullPath));
    scanCount++;

    if (scanCount % BATCH_SIZE === 0) {
      updateScanProgress(scanCount);
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

async function handleDrop(e) {
  const dt = e.dataTransfer;
  const items = dt.items;
  const rawFiles = dt.files;

  const entries = [];
  if (items && items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 1 && entries[0].isDirectory) {
    resetState();
    projectName = entries[0].name;
    const progressEl = document.getElementById('scan-progress');
    progressEl.hidden = false;
    document.getElementById('scan-count').textContent = '0';

    await walkFileSystemEntry(entries[0], '');

    progressEl.hidden = true;
    updateScanProgress(scanCount);
    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree();
    return;
  }

  if (entries.length === 1 && entries[0].isFile) {
    if (/\.(zip|tar|gz|tgz|tar\.gz)$/i.test(entries[0].name)) {
      const file = await new Promise((resolve, reject) => entries[0].file(resolve, reject));
      await handleArchiveUpload(file);
      return;
    }
  }

  if (rawFiles && rawFiles.length) {
    if (rawFiles.length === 1 && /\.(zip|tar|gz|tgz|tar\.gz)$/i.test(rawFiles[0].name)) {
      await handleArchiveUpload(rawFiles[0]);
      return;
    }
    handleLegacyPicker(rawFiles);
    return;
  }

  alert('⚠️ 未识别到可读取的内容，请拖入文件夹或压缩包');
}

// ==================== 后缀筛选 UI ====================
function renderExtensionFilters() {
  const container = document.getElementById('extension-filters');
  container.innerHTML = '';

  if (allExtensions.size === 0) {
    container.innerHTML = '<span class="chips-empty">暂无文件，请先选择来源</span>';
    return;
  }

  Array.from(allExtensions).sort((a, b) => a.localeCompare(b)).forEach(ext => {
    const label = document.createElement('label');
    label.className = 'chip';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = ext;
    checkbox.checked = extensionFilters.has(ext);
    checkbox.id = 'ext-' + ext;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) extensionFilters.add(ext);
      else extensionFilters.delete(ext);
      applyExtensionFilter();
    });

    label.htmlFor = checkbox.id;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(ext));
    container.appendChild(label);
  });
}

function applyExtensionFilter() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  $('#tree-container [data-file="true"]').each((_, el) => {
    const nodeId = el.id;
    if (extensionFilters.has(getExtension(nodeId))) {
      tree.show_node(nodeId);
    } else {
      tree.hide_node(nodeId);
      if (tree.is_selected(nodeId)) tree.deselect_node(nodeId);
    }
  });
  updateSelectedInfo();
}

function updateSelectedInfo() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  selectedPaths = tree.get_selected().filter(id => fileMap[id]);
  const totalBytes = selectedPaths.reduce((sum, path) => sum + fileMap[path].size, 0);
  document.getElementById('size-display').textContent = formatBytes(totalBytes);
}

// ==================== 构建文件树 ====================
function buildTree() {
  const tree = {};
  Object.entries(fileMap).forEach(([path, file]) => {
    const parts = path.split('/');
    let current = tree;
    parts.forEach((part, idx) => {
      if (!current[part]) current[part] = { __children: {}, __file: null };
      if (idx === parts.length - 1) current[part].__file = file;
      current = current[part].__children;
    });
  });

  const nodes = [];
  const rootId = '__ROOT__';

  nodes.push({
    id: rootId,
    parent: '#',
    text: (projectName || '项目') + '/',
    icon: undefined,
    li_attr: { 'data-file': 'false', 'data-ext': '' }
  });

  function recurse(obj, parentPath) {
    const sorted = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file, bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    sorted.forEach(([name, data]) => {
      const currentPath = parentPath === rootId ? name : parentPath + '/' + name;
      const isFile = !!data.__file;

      nodes.push({
        id: currentPath,
        parent: parentPath,
        text: isFile ? name + ' (' + formatBytes(data.__file.size) + ')' : name,
        icon: isFile ? 'jstree-file' : undefined,
        li_attr: {
          'data-file': isFile ? 'true' : 'false',
          'data-ext': isFile ? getExtension(currentPath) : ''
        }
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
      core: {
        data: nodes,
        themes: { dots: true, icons: true, responsive: true },
        multiple: true
      },
      plugins: ['checkbox']
    })
    .on('ready.jstree', function () {
      applyExtensionFilter();
      const t = $('#tree-container').jstree(true);
      if (t) t.open_node(rootId);
    })
    .on('changed.jstree', function () {
      updateSelectedInfo();
    });
}

// ==================== 生成 ASCII 目录树 ====================
function generateDirectoryTree() {
  const filteredTree = {};
  selectedPaths.forEach(path => {
    const parts = path.split('/');
    let current = filteredTree;
    parts.forEach((part, idx) => {
      if (!current[part]) current[part] = { __children: {} };
      if (idx === parts.length - 1) current[part].__file = true;
      current = current[part].__children;
    });
  });

  function buildTreeString(node, prefix = '', isLast = true) {
    if (Object.keys(node).length === 0) return '';

    const entries = Object.entries(node).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file, bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    let result = '';
    entries.forEach(([name, data], index) => {
      const isLastEntry = index === entries.length - 1;
      const hasChildren = Object.keys(data.__children || {}).length > 0;
      const isFile = !!data.__file;

      result += prefix + (isLast ? '└── ' : '├── ') + name;
      if (!isFile && hasChildren) result += '/';
      result += '\n';

      if (hasChildren) {
        result += buildTreeString(data.__children, prefix + (isLast ? '    ' : '│   '), isLastEntry);
      }
    });
    return result;
  }

  let treeString = (projectName || '项目') + '/\n';
  if (selectedPaths.length === 0) {
    treeString += '└── (无选中文件)\n';
  } else {
    treeString += buildTreeString(filteredTree, '', true);
  }
  return treeString;
}

// ==================== 生成 Markdown ====================
// ★ 修改：同时在生成过程中记录大纲（window.mdOutline），并在完成后通知 UI 刷新目录
async function generateMarkdown() {
  let mdParts = [];
  const sectionRefs = [];   // { level, title, partIndex }

  const progressEl = document.getElementById('generate-progress');
  const statusSpan = document.getElementById('generate-status');

  progressEl.hidden = false;

  // ---- 1. 顶部标题（一级） ----
  sectionRefs.push({ level: 1, title: '项目概览：' + (projectName || 'untitled'), partIndex: mdParts.length });
  mdParts.push('# 项目概览：' + (projectName || 'untitled') + '\n');

  // ---- 2. 目录结构标题（二级） ----
  sectionRefs.push({ level: 2, title: '📁 目录结构', partIndex: mdParts.length });
  mdParts.push('## 📁 目录结构\n');
  mdParts.push('\n' + generateDirectoryTree() + '\n```\n');

  // ---- 3. 文件内容 ----
  if (selectedPaths.length === 0) {
    mdParts.push('*(未选中任何文件)*');
  } else {
    sectionRefs.push({ level: 2, title: '📄 文件内容', partIndex: mdParts.length });
    mdParts.push('## 📄 文件内容\n');

    const total = selectedPaths.length;
    for (let i = 0; i < total; i++) {
      const path = selectedPaths[i];
      const file = fileMap[path];
      const ext = getExtension(path);

      statusSpan.textContent = '(' + (i + 1) + '/' + total + ') ' + path;
      await new Promise(resolve => setTimeout(resolve, 0));

      // 记录每个文件三级标题的位置
      sectionRefs.push({ level: 3, title: path, partIndex: mdParts.length });

      if (await isBinaryFile(file, path)) {
        mdParts.push('### `' + path + '`\n[二进制文件，已跳过]\n```');
        continue;
      }
      try {
        const content = await readTextFileStream(file);
        mdParts.push('### `' + path + '`\n```' + (ext === '[无后缀]' ? '' : ext) + '\n' + content + '\n```');
      } catch (e) {
        mdParts.push('### `' + path + '`\n```\n[读取失败: ' + (e.message || '未知错误') + ']\n```');
      }
    }
  }
  progressEl.hidden = true;

  // ---- 4. 计算每个标题在最终字符串中的字符偏移 ----
  const joiner = '\n\n';
  const offsets = new Array(mdParts.length);
  let acc = 0;
  for (let i = 0; i < mdParts.length; i++) {
    offsets[i] = acc;
    acc += mdParts[i].length + (i < mdParts.length - 1 ? joiner.length : 0);
  }

  // ---- 5. 写入全局大纲，供悬浮目录使用 ----
  window.mdOutline = sectionRefs.map(ref => ({
    level: ref.level,
    title: ref.title,
    offset: offsets[ref.partIndex] || 0
  }));

  // ---- 6. 如果页面里挂载了 renderMdToc（见 index.html 内联脚本），就刷新 ----
  if (typeof window.renderMdToc === 'function') {
    try { window.renderMdToc(); } catch (e) { console.warn('TOC 渲染失败：', e); }
  }

  return mdParts.join(joiner);
}

// ==================== 敏感文件检测 ====================
function hasSensitiveFiles(paths) {
  return paths.some(path => {
    const lower = path.toLowerCase();
    return SENSITIVE_KEYWORDS.some(keyword => lower.includes(keyword));
  });
}

// ==================== 导出 .md 文件 ====================
function downloadMarkdown(content, name) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = (name || 'project') + '_' + date + '.md';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==================== 事件绑定 ====================
function initUI() {
  const pickBtn = document.getElementById('pick-btn');
  const pickMenu = document.getElementById('pick-menu');
  const menuFolder = document.getElementById('menu-folder');
  const menuArchive = document.getElementById('menu-archive');
  const dirInput = document.getElementById('directory-picker');
  const archiveInput = document.getElementById('archive-upload');
  const dropZone = document.getElementById('drop-zone');

  function openMenu() {
    pickMenu.hidden = false;
    pickBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    pickMenu.hidden = true;
    pickBtn.setAttribute('aria-expanded', 'false');
  }

  pickBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pickMenu.hidden) openMenu(); else closeMenu();
  });

  document.addEventListener('click', (e) => {
    if (!pickMenu.hidden && !pickMenu.contains(e.target) && e.target !== pickBtn) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pickMenu.hidden) closeMenu();
  });

  menuFolder.addEventListener('click', async () => {
    closeMenu();
    if ('showDirectoryPicker' in window) {
      await pickDirectoryModern();
    } else {
      dirInput.click();
    }
  });

  menuArchive.addEventListener('click', () => {
    closeMenu();
    archiveInput.click();
  });

  dirInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleLegacyPicker(e.target.files);
    e.target.value = '';
  });

  archiveInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleArchiveUpload(e.target.files[0]);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === 'dragleave' && dropZone.contains(e.relatedTarget)) return;
      dropZone.classList.remove('drag-over');
    });
  });
  dropZone.addEventListener('drop', handleDrop);

  document.getElementById('generate-btn').addEventListener('click', async () => {
    if (selectedPaths.length === 0) {
      alert('⚠️ 请先选择文件');
      return;
    }
    if (hasSensitiveFiles(selectedPaths)) {
      if (!confirm('⚠️ 检测到可能包含敏感信息的文件（如密钥、密码等），是否继续？')) return;
    }
    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    try {
      const markdown = await generateMarkdown();
      document.getElementById('markdown-output').value = markdown;
      // 让 textarea 回滚到顶部，避免上次滚动位置残留
      document.getElementById('markdown-output').scrollTop = 0;
    } catch (e) {
      console.error(e);
      alert('生成失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📝 生成 Markdown';
    }
  });

  document.getElementById('copy-btn').addEventListener('click', async () => {
    const text = document.getElementById('markdown-output').value;
    if (!text.trim()) {
      alert('⚠️ 暂无内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      alert('✅ 已复制到剪贴板');
    } catch (e) {
      const textarea = document.getElementById('markdown-output');
      textarea.select();
      document.execCommand('copy');
      alert('✅ 已复制到剪贴板');
    }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const content = document.getElementById('markdown-output').value;
    if (!content.trim()) {
      alert('请先生成 Markdown 内容');
      return;
    }
    downloadMarkdown(content, projectName);
  });

  const shareBtn = document.getElementById('share-btn');
  if (navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', async () => {
      const content = document.getElementById('markdown-output').value;
      if (!content.trim()) {
        alert('请先生成 Markdown 内容');
        return;
      }
      try {
        await navigator.share({
          title: projectName + ' - Markdown',
          text: '项目 ' + projectName + ' 的 Markdown 文档'
        });
      } catch (e) {
        if (e.name !== 'AbortError') alert('分享失败');
      }
    });
  }

  renderExtensionFilters();
}

// ==================== 启动 ====================
initUI();