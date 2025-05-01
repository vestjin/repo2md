let fileMap = {};        // {relativePath: File}
let selectedPaths = [];  // 当前选择路径
let allExtensions = new Set();
let extensionFilters = new Set();  // 当前勾选的后缀名

document.getElementById('directory-picker').addEventListener('change', function (e) {
  fileMap = {};
  selectedPaths = [];
  allExtensions = new Set();
  extensionFilters = new Set();

  const files = Array.from(e.target.files);

  files.forEach(file => {
    const relativePath = file.webkitRelativePath || file.name;
    fileMap[relativePath] = file;

    const ext = getExtension(relativePath);
    allExtensions.add(ext);
  });

  extensionFilters = new Set(allExtensions);
  renderExtensionFilters();
  buildTree();
});

function getExtension(path) {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  const dotIndex = file.lastIndexOf('.');
  return dotIndex === -1 ? '[无后缀]' : file.substring(dotIndex + 1);
}

function renderExtensionFilters() {
  const container = document.getElementById("extension-filters");
  container.innerHTML = "";

  allExtensions.forEach(ext => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = ext;
    checkbox.checked = false;
    checkbox.id = `ext-${ext}`;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        extensionFilters.add(ext);
      } else {
        extensionFilters.delete(ext);
      }
      buildTree(); // 重新构建树
    });

    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.style.marginRight = "10px";
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + ext));

    container.appendChild(label);
  });
}

function buildTree() {
  const nodes = [];
  const tree = {};

  // 构建树结构
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

  // 转换为 jsTree 所需格式
  function recurse(obj, path = '') {
    return Object.entries(obj).map(([name, data]) => {
      const fullPath = path ? `${path}/${name}` : name;
      const isFile = !!data.__file;
      return {
        id: fullPath,
        parent: path || '#',
        text: isFile
          ? `${name} (${data.__file.size} bytes)`
          : name,
        icon: isFile ? "jstree-file" : undefined,
        li_attr: { "data-file": isFile ? "true" : "false" }
      };
    }).flatMap(node => {
      const children = obj[node.text.split(' ')[0]]?.__children || {};
      return [node, ...recurse(children, node.id)];
    });
  }

  $('#tree-container')
    .jstree('destroy')
    .empty()
    .jstree({
      core: {
        data: recurse(tree),
        themes: {
          dots: true,
          icons: true
        },
        multiple: true
      },
      plugins: ["checkbox"]
    })
    .on("changed.jstree", function (e, data) {
      selectedPaths = data.selected.filter(p => fileMap[p]);
      const totalChars = selectedPaths.reduce((sum, path) => sum + fileMap[path].size, 0);
      document.getElementById("char-count").textContent = totalChars;
    });
}

document.getElementById('generate-btn').addEventListener('click', async () => {
  let mdParts = [];

  for (let path of selectedPaths) {
    const file = fileMap[path];
    const ext = getExtension(path);
    const content = await file.text();
    mdParts.push(`### ${path}\n\`\`\`${ext === '[无后缀]' ? '' : ext}\n${content}\n\`\`\``);
  }

  document.getElementById('markdown-output').value = mdParts.join('\n\n');
});

document.getElementById('copy-btn').addEventListener('click', () => {
  const text = document.getElementById('markdown-output').value;
  navigator.clipboard.writeText(text).then(() => {
    alert("✅ 已复制到剪贴板");
  });
});
