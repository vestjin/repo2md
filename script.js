// ==================== 全局状态 ====================
let fileMap = {};          // { relativePath: File }
let selectedPaths = [];    // 当前勾选的文件路径
let allExtensions = new Set();
let extensionFilters = new Set();
let projectName = "";      // 从根目录名称获取

// ==================== 工具函数 ====================
function getExtension(path) {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  const dotIndex = file.lastIndexOf('.');
  return dotIndex === -1 ? '[无后缀]' : file.substring(dotIndex + 1);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ==================== 新版文件夹选择 (File System Access API) ====================
async function pickDirectoryModern() {
  if (!('showDirectoryPicker' in window)) {
    alert('您的浏览器不支持新版文件夹选择，已自动切换到传统模式。');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker();
    projectName = dirHandle.name;          // 保存项目名
    fileMap = {};
    allExtensions.clear();
    extensionFilters.clear();

    // 递归遍历目录
    await walkDirectory(dirHandle, '');

    // 默认全选所有后缀
    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree();
  } catch (err) {
    if (err.name === 'AbortError') return; // 用户取消
    console.error(err);
    alert('读取文件夹失败：' + err.message);
  }
}

// 递归读取目录，填充 fileMap 和 allExtensions
async function walkDirectory(dirHandle, basePath) {
  for await (const entry of dirHandle.values()) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      fileMap[fullPath] = file;
      const ext = getExtension(fullPath);
      allExtensions.add(ext);
    } else if (entry.kind === 'directory') {
      await walkDirectory(entry, fullPath);
    }
  }
}

// ==================== 传统文件夹选择 (webkitdirectory) ====================
function handleLegacyPicker(files) {
  fileMap = {};
  allExtensions.clear();
  extensionFilters.clear();

  // 尝试从第一个文件的路径中提取项目名
  if (files.length > 0) {
    const firstPath = files[0].webkitRelativePath || files[0].name;
    projectName = firstPath.split('/')[0] || 'untitled';
  }

  Array.from(files).forEach(file => {
    const relativePath = file.webkitRelativePath || file.name;
    fileMap[relativePath] = file;
    const ext = getExtension(relativePath);
    allExtensions.add(ext);
  });

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
      buildTree(); // 第一阶段仍采用重建，后续可优化为hide/show
    });

    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.style.marginRight = "10px";
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + ext));

    container.appendChild(label);
  });
}

// ==================== 构建文件树（带排序） ====================
function buildTree() {
  const tree = {};

  // 1. 过滤并构建嵌套对象
  Object.entries(fileMap).forEach(([path, file]) => {
    const ext = getExtension(path);
    if (!extensionFilters.has(ext)) return;

    const parts = path.split('/');
    let current = tree;

    parts.forEach((part, idx) => {
      if (!current[part]) {
        current[part] = { __children: {} };
      }
      if (idx === parts.length - 1) {
        current[part].__file = file;
      }
      current = current[part].__children;
    });
  });

  // 2. 递归生成jsTree节点（核心改进：目录优先+字母序）
  function recurse(obj, path = '') {
    // 排序：目录优先，同层按字母序（不区分大小写）
    const sortedEntries = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1; // 目录在前
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });

    return sortedEntries.flatMap(([name, data]) => {
      const fullPath = path ? `${path}/${name}` : name;
      const isFile = !!data.__file;
      const node = {
        id: fullPath,
        parent: path || '#',
        text: isFile
          ? `${name} (${formatBytes(data.__file.size)})`
          : name,
        icon: isFile ? "jstree-file" : undefined,
        li_attr: { "data-file": isFile ? "true" : "false" }
      };
      const children = data.__children || {};
      return [node, ...recurse(children, node.id)];
    });
  }

  // 3. 渲染jsTree
  $('#tree-container')
    .jstree('destroy')
    .empty()
    .jstree({
      core: {
        data: recurse(tree),
        themes: { dots: true, icons: true },
        multiple: true
      },
      plugins: ["checkbox"]
    })
    .on("changed.jstree", function (e, data) {
      selectedPaths = data.selected.filter(p => fileMap[p]);
      const totalBytes = selectedPaths.reduce((sum, path) => sum + fileMap[path].size, 0);
      document.getElementById("size-display").textContent = formatBytes(totalBytes);
    });
}

// ==================== 初始化UI ====================
function initUI() {
  // 检测新版API支持情况，控制按钮显隐
  const modernBtn = document.getElementById('modern-picker-btn');
  const legacyLabel = document.getElementById('legacy-picker-label');
  const legacyInput = document.getElementById('directory-picker');

  if ('showDirectoryPicker' in window) {
    modernBtn.style.display = 'block';
    legacyLabel.style.display = 'none';   // 隐藏传统按钮
    modernBtn.addEventListener('click', pickDirectoryModern);
  } else {
    modernBtn.style.display = 'none';
    legacyLabel.style.display = 'block';
    // 传统模式事件监听
    legacyInput.addEventListener('change', (e) => {
      handleLegacyPicker(e.target.files);
    });
  }

  // 生成Markdown按钮
  document.getElementById('generate-btn').addEventListener('click', async () => {
    let mdParts = [];

    // 项目概览标题
    mdParts.push(`# 项目概览：${projectName || 'untitled'}\n`);

    // TODO: 目录树生成（第二阶段实现）
    mdParts.push(`## 📁 目录结构\n\n\`\`\`\n${projectName}/\n└── ...\n\`\`\`\n`);

    // 文件内容
    for (let path of selectedPaths) {
      const file = fileMap[path];
      const ext = getExtension(path);
      try {
        const content = await file.text();
        mdParts.push(`### \`${path}\`\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
      } catch (e) {
        mdParts.push(`### \`${path}\`\n\`\`\`\n[无法读取文件: 可能是二进制或过大]\n\`\`\``);
      }
    }

    document.getElementById('markdown-output').value = mdParts.join('\n\n');
  });

  // 复制按钮
  document.getElementById('copy-btn').addEventListener('click', () => {
    const text = document.getElementById('markdown-output').value;
    navigator.clipboard.writeText(text).then(() => {
      alert("✅ 已复制到剪贴板");
    }).catch(() => {
      alert("❌ 复制失败，请手动选择复制");
    });
  });
}

// 启动
initUI();