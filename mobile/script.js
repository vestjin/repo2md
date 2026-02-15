// ==================== 全局状态 ====================
let fileMap = {};
let selectedPaths = [];
let allExtensions = new Set();
let extensionFilters = new Set();
let projectName = "";
let extractCount = 0;

// ==================== 常量定义 ====================
const BATCH_UPDATE = 50; // 批量更新UI的阈值

// ==================== 二进制扩展名黑名单 ====================
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
  'mp4', 'mp3', 'avi', 'mov', 'wmv', 'flv', 'webm',
  'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'doc', 'docx',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  'exe', 'dll', 'so', 'dylib',
  'iso', 'img', 'dmg',
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

// ==================== 工具函数 ====================
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

function showToast(message, duration = 2000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.remove(), duration);
}

function showLoading(text = '处理中...') {
  const existing = document.querySelector('.loading');
  if (existing) existing.remove();
  
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = `
    <div class="loading-spinner"></div>
    <div class="loading-text">${text}</div>
  `;
  document.body.appendChild(loading);
}

function hideLoading() {
  const loading = document.querySelector('.loading');
  if (loading) loading.remove();
}

// ==================== 二进制文件检测 ====================
async function isBinaryFile(file, path) {
  const ext = getExtension(path);
  if (BINARY_EXTENSIONS.has(ext)) return true;

  try {
    const header = await file.slice(0, 512).arrayBuffer();
    const view = new Uint8Array(header);
    
    // 常见魔数检测
    if (view[0] === 0x25 && view[1] === 0x50) return true; // PDF, ZIP
    if (view[0] === 0x89 && view[1] === 0x50) return true; // PNG
    if (view[0] === 0xFF && view[1] === 0xD8) return true; // JPEG
    if (view[0] === 0x47 && view[1] === 0x49) return true; // GIF
    if (view[0] === 0x00 && view[1] === 0x00) return true; // 可能是可执行文件
    
    // 检查前512字节中是否包含null字符（文本文件通常不会）
    for (let i = 0; i < Math.min(512, view.length); i++) {
      if (view[i] === 0) return true;
    }
  } catch (e) {
    return true;
  }
  
  return false;
}

// ==================== Tar 解析器 ====================
class TarParser {
  static parse(buffer) {
    const files = [];
    const view = new Uint8Array(buffer);
    let offset = 0;
    
    while (offset < view.length - 512) {
      // 读取文件头（512字节）
      const header = view.slice(offset, offset + 512);
      
      // 检查是否为空块（文件结束）
      let isEmpty = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          isEmpty = false;
          break;
        }
      }
      if (isEmpty) break;
      
      // 解析文件名（前100字节）
      let nameBytes = header.slice(0, 100);
      let nameEnd = 0;
      while (nameEnd < 100 && nameBytes[nameEnd] !== 0) nameEnd++;
      let name = new TextDecoder().decode(nameBytes.slice(0, nameEnd));
      
      // 解析前缀（用于长文件名）
      let prefixBytes = header.slice(345, 500);
      let prefixEnd = 0;
      while (prefixEnd < 155 && prefixBytes[prefixEnd] !== 0) prefixEnd++;
      let prefix = new TextDecoder().decode(prefixBytes.slice(0, prefixEnd));
      
      if (prefix) {
        name = prefix + '/' + name;
      }
      
      // 解析文件大小（八进制）
      let sizeStr = '';
      for (let i = 124; i < 136; i++) {
        if (header[i] === 0 || header[i] === 32) continue;
        sizeStr += String.fromCharCode(header[i]);
      }
      const size = parseInt(sizeStr, 8) || 0;
      
      // 解析文件类型标志
      const typeFlag = header[156];
      const isDir = typeFlag === 53 || typeFlag === 0x35; // '5'
      
      // 跳过头部
      offset += 512;
      
      if (!isDir && name && size > 0) {
        // 提取文件内容
        const content = view.slice(offset, offset + size);
        files.push({
          name: name.replace(/^\.\//, ''),
          content: content,
          size: size
        });
      }
      
      // 跳到下一个512字节边界
      const blocks = Math.ceil(size / 512);
      offset += blocks * 512;
    }
    
    return files;
  }
}

// ==================== 多格式解压 ====================
async function extractArchive(file) {
  const filename = file.name.toLowerCase();
  const ext = filename.split('.').pop();
  
  showLoading('正在解压...');
  
  try {
    let files = [];
    
    // ZIP 格式
    if (ext === 'zip') {
      const zip = await JSZip.loadAsync(file);
      const promises = [];
      
      zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir) {
          promises.push(
            zipEntry.async('uint8array').then(content => {
              files.push({
                name: relativePath,
                content: content,
                size: content.length
              });
            })
          );
        }
      });
      
      await Promise.all(promises);
    }
    // TAR 格式
    else if (ext === 'tar') {
      const buffer = await file.arrayBuffer();
      files = TarParser.parse(buffer);
    }
    // TAR.GZ / TGZ 格式
    else if (ext === 'gz' || ext === 'tgz' || filename.endsWith('.tar.gz')) {
      const buffer = await file.arrayBuffer();
      const decompressed = pako.ungzip(new Uint8Array(buffer));
      files = TarParser.parse(decompressed.buffer);
    }
    else {
      throw new Error('不支持的压缩格式');
    }
    
    hideLoading();
    return files;
    
  } catch (error) {
    hideLoading();
    throw error;
  }
}

// ==================== 处理压缩包 ====================
async function handleArchiveUpload(file) {
  // 隐藏文件信息区域（用户要求移除）
  document.getElementById('file-info').style.display = 'none';
  
  // 重置状态
  extractCount = 0;
  fileMap = {};
  allExtensions.clear();
  extensionFilters.clear();
  
  const progressEl = document.getElementById('extract-progress');
  progressEl.style.display = 'block';
  document.getElementById('extract-status').textContent = '正在解压...';
  document.getElementById('extract-count').textContent = '0';
  
  try {
    // 解压文件
    const files = await extractArchive(file);
    
    // 路径预处理，提取公共顶级目录
    let candidateName = '';
    if (files.length > 0) {
      const firstPath = files[0].name;
      const parts = firstPath.split('/');
      candidateName = parts[0];
    }

    // 检查是否所有文件都以候选名开头（或是候选名本身）
    let useCandidate = true;
    if (candidateName) {
      for (const f of files) {
        if (!f.name.startsWith(candidateName + '/') && f.name !== candidateName) {
          useCandidate = false;
          break;
        }
      }
    } else {
      useCandidate = false;
    }

    const newFileMap = {};
    const newExtensions = new Set();
    let newExtractCount = 0;

    if (useCandidate) {
      projectName = candidateName;
      for (const [index, extractedFile] of files.entries()) {
        let relativePath = extractedFile.name;
        if (relativePath.startsWith(projectName + '/')) {
          relativePath = relativePath.substring(projectName.length + 1);
        } // 若等于 projectName，则作为根目录下的文件

        const blob = new Blob([extractedFile.content]);
        const fileObj = new File([blob], relativePath.split('/').pop(), {
          lastModified: Date.now(),
          type: 'application/octet-stream'
        });
        fileObj.size = extractedFile.size;
        newFileMap[relativePath] = fileObj;

        const ext = getExtension(relativePath);
        newExtensions.add(ext);

        newExtractCount++;

        // 批量更新UI
        if ((index + 1) % BATCH_UPDATE === 0 || index === files.length - 1) {
          document.getElementById('extract-count').textContent = newExtractCount;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } else {
      projectName = file.name.replace(/\.(zip|tar|gz|tgz|tar\.gz)$/i, '');
      for (const [index, extractedFile] of files.entries()) {
        const relativePath = extractedFile.name;
        const blob = new Blob([extractedFile.content]);
        const fileObj = new File([blob], relativePath.split('/').pop(), {
          lastModified: Date.now(),
          type: 'application/octet-stream'
        });
        fileObj.size = extractedFile.size;
        newFileMap[relativePath] = fileObj;

        const ext = getExtension(relativePath);
        newExtensions.add(ext);

        newExtractCount++;

        if ((index + 1) % BATCH_UPDATE === 0 || index === files.length - 1) {
          document.getElementById('extract-count').textContent = newExtractCount;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }

    // 更新全局变量
    fileMap = newFileMap;
    allExtensions = newExtensions;
    extractCount = newExtractCount;

    progressEl.style.display = 'none';
    
    // 显示加载提示，准备构建树
    showLoading('正在加载文件列表...');
    await new Promise(resolve => setTimeout(resolve, 0)); // 确保动画显示
    
    // 渲染后缀筛选
    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    
    // 构建文件树（扁平节点列表）
    buildTree();
    
    hideLoading();
    
    // 显示其他区域
    document.getElementById('filter-section').style.display = 'block';
    document.getElementById('tree-section').style.display = 'block';
    document.getElementById('action-section').style.display = 'block';
    
    // 检测是否支持 Web Share API
    if (navigator.share) {
      document.getElementById('share-btn').style.display = 'block';
      document.querySelector('.btn-group').classList.add('three-col');
    }
    
    showToast(`✅ 解压成功，共 ${files.length} 个文件`);
    
  } catch (error) {
    progressEl.style.display = 'none';
    hideLoading();
    console.error(error);
    showToast('❌ 解压失败：' + error.message);
  }
}

// ==================== 后缀筛选 UI ====================
function renderExtensionFilters() {
  const container = document.getElementById("extension-filters");
  container.innerHTML = "";

  const sortedExts = Array.from(allExtensions).sort((a, b) => a.localeCompare(b));
  
  sortedExts.forEach(ext => {
    const item = document.createElement("div");
    item.className = "filter-item active";
    item.textContent = ext;
    item.dataset.ext = ext;

    item.addEventListener("click", () => {
      item.classList.toggle("active");
      
      if (item.classList.contains("active")) {
        extensionFilters.add(ext);
      } else {
        extensionFilters.delete(ext);
      }
      
      applyExtensionFilter();
    });

    container.appendChild(item);
  });
  
  // 绑定折叠事件
  const toggle = document.getElementById('filter-toggle');
  toggle.onclick = () => {
    container.classList.toggle('collapsed');
    const icon = toggle.querySelector('.toggle-icon');
    icon.textContent = container.classList.contains('collapsed') ? '▶' : '▼';
  };
}

// ==================== 应用后缀筛选 ====================
function applyExtensionFilter() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  // 获取所有文件节点
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
  document.getElementById("size-display").textContent = `已选: ${formatBytes(totalBytes)}`;
}

// ==================== 构建文件树（扁平节点列表）====================
function buildTree() {
  const rootId = projectName || '项目';
  const nodes = [];
  const nodeMap = new Set(); // 记录已添加的节点ID，防止重复

  // 1. 添加根节点
  nodeMap.add(rootId);
  nodes.push({
    id: rootId,
    parent: '#',
    text: rootId + '/',
    li_attr: { "data-file": "false", "data-ext": "" }
  });

  // 2. 收集所有目录路径（带斜杠）
  const dirPaths = new Set();
  Object.keys(fileMap).forEach(path => {
    const parts = path.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dir = dir ? dir + '/' + parts[i] : parts[i];
      dirPaths.add(dir + '/');
    }
  });

  // 3. 按路径长度排序，确保父目录先添加
  const sortedDirs = Array.from(dirPaths).sort((a, b) => a.split('/').length - b.split('/').length);
  sortedDirs.forEach(dirId => {
    if (nodeMap.has(dirId)) return;
    // 获取目录名（去除末尾斜杠后取最后一段）
    const name = dirId.substring(0, dirId.length - 1).split('/').pop();
    // 确定父节点ID
    let parentId;
    if (dirId === rootId + '/') {
      parentId = rootId; // 根目录下的子目录，父节点为根节点
    } else {
      // 去掉最后一级，得到父目录ID
      const parentDir = dirId.substring(0, dirId.lastIndexOf('/', dirId.length - 2) + 1);
      parentId = parentDir || rootId;
    }
    nodeMap.add(dirId);
    nodes.push({
      id: dirId,
      parent: parentId,
      text: name,
      icon: "jstree-folder",
      li_attr: { "data-file": "false", "data-ext": "" }
    });
  });

  // 4. 添加文件节点
  Object.keys(fileMap).forEach(path => {
    if (nodeMap.has(path)) return;
    const parts = path.split('/');
    const name = parts[parts.length - 1];
    let parentId;
    if (parts.length === 1) {
      parentId = rootId;
    } else {
      parentId = parts.slice(0, -1).join('/') + '/';
    }
    nodeMap.add(path);
    nodes.push({
      id: path,
      parent: parentId,
      text: `${name} (${formatBytes(fileMap[path].size)})`,
      icon: "jstree-file",
      li_attr: {
        "data-file": "true",
        "data-ext": getExtension(path)
      }
    });
  });

  // 初始化 jsTree
  $('#tree-container')
    .jstree('destroy')
    .empty()
    .jstree({
      core: {
        data: nodes,
        themes: { dots: true, icons: true, responsive: true },
        multiple: true
      },
      plugins: ["checkbox"]
    })
    .on("ready.jstree", function () {
      applyExtensionFilter();
      // 默认展开根节点
      const tree = $('#tree-container').jstree(true);
      tree.open_node(rootId);
    })
    .on("changed.jstree", function () {
      updateSelectedInfo();
    });
}

// ==================== 生成目录树（用于Markdown）====================
function generateDirectoryTree() {
  const filteredTree = {};

  selectedPaths.forEach(path => {
    const parts = path.split('/');
    let current = filteredTree;

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

  let treeString = `${projectName || '项目'}/\n`;
  if (selectedPaths.length === 0) {
    treeString += '└── (无选中文件)\n';
  } else {
    treeString += buildTreeString(filteredTree, '', true);
  }
  return treeString;
}

// ==================== 生成 Markdown ====================
async function generateMarkdown() {
  const progressEl = document.getElementById('generate-progress');
  const statusSpan = document.getElementById('generate-status');
  
  progressEl.style.display = 'block';
  statusSpan.textContent = '正在生成...';
  
  let mdParts = [];
  
  // 项目概览
  mdParts.push(`# 项目概览：${projectName || 'untitled'}\n`);
  
  // 目录结构
  mdParts.push(`## 📁 目录结构\n`);
  mdParts.push('```\n' + generateDirectoryTree() + '\n```\n');
  
  // 文件内容
  if (selectedPaths.length === 0) {
    mdParts.push('*(未选中任何文件)*');
  } else {
    mdParts.push(`## 📄 文件内容\n`);
    const total = selectedPaths.length;
    for (let i = 0; i < total; i++) {
      const path = selectedPaths[i];
      const file = fileMap[path];
      const ext = getExtension(path);

      statusSpan.textContent = `(${i+1}/${total}) ${path.split('/').pop()}`;
      await new Promise(resolve => setTimeout(resolve, 0));

      const binary = await isBinaryFile(file, path);
      if (binary) {
        mdParts.push(`### \`${path}\`\n\`\`\`\n[二进制文件，已跳过]\n\`\`\``);
        continue;
      }

      try {
        const reader = new FileReader();
        const content = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsText(file);
        });
        
        mdParts.push(`### \`${path}\`\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
      } catch (e) {
        mdParts.push(`### \`${path}\`\n\`\`\`\n[读取失败:${e.message || '未知错误'}]\n\`\`\``);
      }
    }
  }

  progressEl.style.display = 'none';
  return mdParts.join('\n\n');
}

// ==================== 敏感文件检测 ====================
function hasSensitiveFiles(paths) {
  return paths.some(path => {
    const lower = path.toLowerCase();
    return SENSITIVE_KEYWORDS.some(keyword => lower.includes(keyword));
  });
}

// ==================== 导出文件 ====================
function downloadMarkdown(content, name) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${name || 'project'}_${date}.md`;
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
  // 上传按钮
  document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('archive-upload').click();
  });

  // 文件选择
  document.getElementById('archive-upload').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleArchiveUpload(e.target.files[0]);
    }
  });

  // 生成 Markdown
  document.getElementById('generate-btn').addEventListener('click', async () => {
    if (selectedPaths.length === 0) {
      showToast('⚠️ 请先选择文件');
      return;
    }
    if (hasSensitiveFiles(selectedPaths)) {
      if (!confirm('⚠️ 检测到可能包含敏感信息的文件，是否继续？')) {
        return;
      }
    }

    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> 生成中...';

    try {
      const markdown = await generateMarkdown();
      const output = document.getElementById('markdown-output');
      output.value = markdown;
      
      document.getElementById('output-section').style.display = 'block';
      document.getElementById('char-count').textContent = `${markdown.length} 字符`;
      
      // 滚动到输出区域
      document.getElementById('output-section').scrollIntoView({ behavior: 'smooth' });
      
      showToast('✅ 生成成功');
    } catch (e) {
      console.error(e);
      showToast('❌ 生成失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>📝</span> 生成 Markdown';
    }
  });

  // 复制
  document.getElementById('copy-btn').addEventListener('click', async () => {
    const text = document.getElementById('markdown-output').value;
    if (!text.trim()) {
      showToast('⚠️ 暂无内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('✅ 已复制到剪贴板');
    } catch (e) {
      // 降级方案：选中文本
      const textarea = document.getElementById('markdown-output');
      textarea.select();
      document.execCommand('copy');
      showToast('✅ 已复制到剪贴板');
    }
  });

  // 导出
  document.getElementById('export-btn').addEventListener('click', () => {
    const content = document.getElementById('markdown-output').value;
    if (!content.trim()) {
      showToast('⚠️ 请先生成 Markdown');
      return;
    }
    downloadMarkdown(content, projectName);
    showToast('✅ 导出成功');
  });

  // 分享
  const shareBtn = document.getElementById('share-btn');
  if (navigator.share) {
    shareBtn.addEventListener('click', async () => {
      const content = document.getElementById('markdown-output').value;
      if (!content.trim()) {
        showToast('⚠️ 请先生成 Markdown');
        return;
      }
      try {
        await navigator.share({
          title: `${projectName} - Markdown`,
          text: `项目 ${projectName} 的 Markdown 文档`,
        });
      } catch (e) {
        if (e.name !== 'AbortError') {
          showToast('分享失败');
        }
      }
    });
  }
}

// ==================== 启动 ====================
initUI();