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

// ==================== 新版文件夹选择 ====================
async function pickDirectoryModern() {
  if (!('showDirectoryPicker' in window)) {
    alert('您的浏览器不支持新版文件夹选择，已自动切换到传统模式。');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker();
    projectName = dirHandle.name;
    fileMap = {};
    allExtensions.clear();
    extensionFilters.clear();

    await walkDirectory(dirHandle, '');

    extensionFilters = new Set(allExtensions);
    renderExtensionFilters();
    buildTree(); // 构建完整树（不再过滤）
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    alert('读取文件夹失败：' + err.message);
  }
}

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

// ==================== 传统文件夹选择 ====================
function handleLegacyPicker(files) {
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
  });

  extensionFilters = new Set(allExtensions);
  renderExtensionFilters();
  buildTree(); // 构建完整树（不再过滤）
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

    // 【性能优化】不再调用 buildTree，而是调用快速筛选函数
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        extensionFilters.add(ext);
      } else {
        extensionFilters.delete(ext);
      }
      applyExtensionFilter(); // ← 关键优化：仅隐藏/显示节点
    });

    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.style.marginRight = "10px";
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + ext));

    container.appendChild(label);
  });
}

// ==================== 【新增】快速后缀筛选（不重建树）====================
function applyExtensionFilter() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  // 获取所有文件节点（已渲染的li元素）
  const allFileNodes = $('#tree-container [data-file="true"]');

  allFileNodes.each((_, el) => {
    const nodeId = el.id;          // li 的 id 即文件路径
    const ext = getExtension(nodeId);
    const shouldShow = extensionFilters.has(ext);

    if (shouldShow) {
      tree.show_node(nodeId);
    } else {
      // 隐藏节点，并确保它不被选中
      tree.hide_node(nodeId);
      if (tree.is_selected(nodeId)) {
        tree.deselect_node(nodeId);
      }
    }
  });

  // 更新 selectedPaths 和总大小
  updateSelectedInfo();
}

// 更新选中信息（从树中获取当前选中的文件节点）
function updateSelectedInfo() {
  const tree = $('#tree-container').jstree(true);
  if (!tree) return;

  const selectedIds = tree.get_selected();
  selectedPaths = selectedIds.filter(id => fileMap[id]);

  const totalBytes = selectedPaths.reduce((sum, path) => sum + fileMap[path].size, 0);
  document.getElementById("size-display").textContent = formatBytes(totalBytes);
}

// ==================== 构建文件树（完整渲染 + 排序）====================
function buildTree() {
  const tree = {};

  // 1. 【修改】不再根据后缀过滤，所有文件全部加入树
  Object.entries(fileMap).forEach(([path, file]) => {
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

  // 2. 递归生成jsTree节点（目录优先 + 字母序）
  function recurse(obj, path = '') {
    const sortedEntries = Object.entries(obj).sort(([aName, aData], [bName, bData]) => {
      const aIsDir = !aData.__file;
      const bIsDir = !bData.__file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
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
        li_attr: {
          "data-file": isFile ? "true" : "false",
          "data-ext": isFile ? getExtension(fullPath) : ""  // 【新增】存储后缀，便于快速筛选
        }
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
    .on("ready.jstree", function () {
      // 【新增】树渲染完成后，立即应用当前筛选（默认全显示）
      applyExtensionFilter();
    })
    .on("changed.jstree", function (e, data) {
      // 更新选中信息（用户手动勾选时）
      updateSelectedInfo();
    });
}

// ==================== 初始化UI ====================
function initUI() {
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

  document.getElementById('generate-btn').addEventListener('click', async () => {
    let mdParts = [];
    mdParts.push(`# 项目概览：${projectName || 'untitled'}\n`);
    mdParts.push(`## 📁 目录结构\n\n\`\`\`\n${projectName}/\n└── ...\n\`\`\`\n`);

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

  document.getElementById('copy-btn').addEventListener('click', () => {
    const text = document.getElementById('markdown-output').value;
    navigator.clipboard.writeText(text).then(() => {
      alert("✅ 已复制到剪贴板");
    }).catch(() => {
      alert("❌ 复制失败，请手动选择复制");
    });
  });
}

initUI();