import sys
import os
import math
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTreeView, QTextEdit, QLabel, QMessageBox,
    QFileDialog, QListWidget, QListWidgetItem, QProgressDialog,
    QAbstractItemView, QSplitter, QLineEdit, QComboBox
)
from PySide6.QtCore import Qt, QThread, Signal, QSortFilterProxyModel, QModelIndex
from PySide6.QtGui import QStandardItemModel, QStandardItem, QClipboard, QFont, QPalette, QColor

# 尝试导入 tiktoken
try:
    import tiktoken
    TIKTOKEN_AVAILABLE = True
except ImportError:
    TIKTOKEN_AVAILABLE = False

# ==================== 常量定义 ====================
BINARY_EXTENSIONS = {
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
    'mp4', 'mp3', 'avi', 'mov', 'wmv', 'flv',
    'pdf', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'rar', '7z', 'tar', 'gz',
    'exe', 'dll', 'so', 'dylib',
    'iso', 'img',
    'woff', 'woff2', 'ttf', 'eot',
    'psd', 'ai', 'eps',
    'bin', 'dat', 'db', 'sqlite', 'cur', 'icns'
}

SENSITIVE_KEYWORDS = [
    '.env', '.key', '.pem', 'id_rsa', 'id_dsa',
    'password', 'secret', 'token', 'credential', 'aws', 'private'
]

# 多语言字符串
STRINGS = {
    'zh': {
        'window_title': 'repo2md - 项目转Markdown',
        'choose_folder': '📁 选择文件夹',
        'no_folder': '未选择文件夹',
        'ext_filter': '🔍 扩展名筛选',
        'file_tree': '📂 项目文件 (勾选所需文件)',
        'size_label': '📦 当前选中总大小: {}',
        'generate': '生成 Markdown',
        'copy': '📋 复制到剪贴板',
        'export': '💾 导出为 .md',
        'search_placeholder': '🔎 搜索文件名...',
        'language': '语言',
        'scanning': '扫描文件中...',
        'generating': '生成 Markdown 中...',
        'warning': '提示',
        'no_selection': '请至少勾选一个文件',
        'sensitive_warning': '选中的文件包含可能敏感的信息：\n{}\n\n确定要继续生成吗？',
        'copy_success': '已复制到剪贴板',
        'copy_fail': '复制失败',
        'export_success': '已保存到 {}',
        'token_warning': '生成的文档大约包含 {} token，可能超过模型限制（128k）。是否继续？',
        'token_estimate_failed': '无法估算 token 数，继续生成吗？',
        'binary_skipped': '[二进制文件，已跳过: {}]',
        'read_failed': '[读取失败: {}]',
    },
    'en': {
        'window_title': 'repo2md - Project to Markdown',
        'choose_folder': '📁 Choose Folder',
        'no_folder': 'No folder selected',
        'ext_filter': '🔍 Extension Filter',
        'file_tree': '📂 Project Files (check files)',
        'size_label': '📦 Total size: {}',
        'generate': 'Generate Markdown',
        'copy': '📋 Copy to Clipboard',
        'export': '💾 Export as .md',
        'search_placeholder': '🔎 Search files...',
        'language': 'Language',
        'scanning': 'Scanning files...',
        'generating': 'Generating Markdown...',
        'warning': 'Warning',
        'no_selection': 'Please select at least one file',
        'sensitive_warning': 'Selected files may contain sensitive information:\n{}\n\nContinue?',
        'copy_success': 'Copied to clipboard',
        'copy_fail': 'Copy failed',
        'export_success': 'Saved to {}',
        'token_warning': 'The generated document contains approximately {} tokens, which may exceed the model limit (128k). Continue?',
        'token_estimate_failed': 'Unable to estimate token count. Continue?',
        'binary_skipped': '[Binary file skipped: {}]',
        'read_failed': '[Read failed: {}]',
    }
}

# ==================== 工具函数 ====================
def format_bytes(size):
    if size == 0:
        return "0 B"
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} TB"

def get_extension(path):
    parts = path.split('/')
    file = parts[-1]
    dot = file.rfind('.')
    if dot == -1:
        return '[无后缀]'
    return file[dot+1:].lower()

def is_binary_file(file_path, check_magic=True):
    ext = get_extension(file_path)
    if ext in BINARY_EXTENSIONS:
        return True, f"扩展名 {ext} 在黑名单中"

    if not check_magic:
        return False, ""

    try:
        with open(file_path, 'rb') as f:
            header = f.read(4)
            if len(header) < 4:
                return False, ""
            if header.startswith(b'%PDF'):
                return True, "魔数 PDF"
            if header.startswith(b'\x89PNG'):
                return True, "魔数 PNG"
            if header.startswith(b'\xFF\xD8\xFF'):
                return True, "魔数 JPEG"
            if header.startswith(b'PK'):
                return True, "魔数 ZIP"
            if header.startswith(b'\x1F\x8B'):
                return True, "魔数 GZIP"
    except Exception:
        return True, "读取失败"

    return False, ""

def read_text_file(file_path):
    encodings = ['utf-8', 'gbk', 'latin-1']
    for enc in encodings:
        try:
            with open(file_path, 'r', encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    with open(file_path, 'rb') as f:
        data = f.read()
        return data.decode('utf-8', errors='ignore')

def estimate_tokens(text):
    """估算 token 数，优先使用 tiktoken"""
    if TIKTOKEN_AVAILABLE:
        try:
            enc = tiktoken.get_encoding("cl100k_base")  # GPT-4 编码
            return len(enc.encode(text))
        except:
            pass
    # 回退方案：按字符数/4 粗略估计（英文为主）
    return len(text) // 4

# ==================== 扫描线程 ====================
class ScanThread(QThread):
    finished_scan = Signal(dict, list)  # {rel: (abs,size)}, extensions list

    def __init__(self, root_path):
        super().__init__()
        self.root_path = root_path

    def run(self):
        file_map = {}
        extensions = set()
        for root, dirs, files in os.walk(self.root_path):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for file in files:
                if file.startswith('.'):
                    continue
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, self.root_path).replace('\\', '/')
                size = os.path.getsize(abs_path)
                file_map[rel_path] = (abs_path, size)
                ext = get_extension(rel_path)
                extensions.add(ext)

        extensions = sorted(extensions, key=lambda x: (x == '[无后缀]', x))
        self.finished_scan.emit(file_map, extensions)

# ==================== 生成 Markdown 线程 ====================
class GenerateThread(QThread):
    progress = Signal(str)      # 当前处理的文件
    result = Signal(str)        # 最终markdown内容

    def __init__(self, root_path, selected_paths, file_map, lang):
        super().__init__()
        self.root_path = root_path
        self.selected_paths = selected_paths
        self.file_map = file_map
        self.lang = lang  # 用于错误信息本地化

    def run(self):
        lines = []
        root_name = os.path.basename(self.root_path)
        s = STRINGS[self.lang]

        lines.append(f"# 项目概览：{root_name}\n")
        tree = self._build_tree(self.selected_paths)
        lines.append("## 📁 目录结构\n")
        lines.append("```\n" + tree + "```\n")

        if not self.selected_paths:
            lines.append("*(未选中任何文件)*")
        else:
            lines.append("## 📄 文件内容\n")
            for i, rel_path in enumerate(self.selected_paths):
                self.progress.emit(f"({i+1}/{len(self.selected_paths)}) {rel_path}")
                abs_path, size = self.file_map[rel_path]

                is_bin, reason = is_binary_file(abs_path)
                if is_bin:
                    lines.append(f"### `{rel_path}`\n```\n{s['binary_skipped'].format(reason)}\n```\n")
                    continue

                try:
                    content = read_text_file(abs_path)
                    ext = get_extension(rel_path)
                    lang = ext if ext != '[无后缀]' else ''
                    lines.append(f"### `{rel_path}`\n```{lang}\n{content}\n```\n")
                except Exception as e:
                    lines.append(f"### `{rel_path}`\n```\n{s['read_failed'].format(e)}\n```\n")

        self.result.emit('\n'.join(lines))

    def _build_tree(self, paths):
        if not paths:
            return f"{os.path.basename(self.root_path)}/\n└── (无选中文件)"

        tree_dict = {}
        for p in paths:
            parts = p.split('/')
            node = tree_dict
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = None

        def _render(subtree, prefix='', is_last=True):
            if not subtree:
                return ''
            items = list(subtree.items())
            items.sort(key=lambda x: (0 if isinstance(x[1], dict) else 1, x[0].lower()))

            result = ''
            for i, (name, child) in enumerate(items):
                last = (i == len(items) - 1)
                line = prefix + ('└── ' if last else '├── ') + name
                if isinstance(child, dict):
                    line += '/'
                result += line + '\n'
                if isinstance(child, dict):
                    result += _render(child, prefix + ('    ' if last else '│   '), last)
            return result

        root_name = os.path.basename(self.root_path)
        return root_name + '/\n' + _render(tree_dict)

# ==================== 扩展名+搜索过滤代理模型 ====================
class FileFilterProxy(QSortFilterProxyModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.allowed_extensions = None
        self.search_text = ""

    def set_allowed_extensions(self, exts):
        self.allowed_extensions = set(exts) if exts is not None else None
        self.invalidateFilter()

    def set_search_text(self, text):
        self.search_text = text.strip().lower()
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row, source_parent):
        # 获取源模型索引
        model = self.sourceModel()
        index = model.index(source_row, 0, source_parent)

        # 获取文件扩展名（如果是文件）
        ext = model.data(index, Qt.UserRole)
        # 检查扩展名过滤
        if ext is not None and self.allowed_extensions is not None:
            if ext not in self.allowed_extensions:
                # 如果扩展名不通过，但如果是目录，仍需检查子节点
                if model.hasChildren(index):
                    # 递归检查子节点
                    if self._has_accepted_child(index):
                        return True
                return False

        # 检查搜索文本
        if self.search_text:
            file_name = model.data(index, Qt.DisplayRole)  # 获取显示文本（可能包含大小）
            # 提取纯文件名（去除大小后缀）
            if '(' in file_name and file_name.endswith(')'):
                file_name = file_name[:file_name.rfind('(')].strip()
            if self.search_text not in file_name.lower():
                # 不匹配，但如果是目录，检查子节点
                if model.hasChildren(index):
                    if self._has_accepted_child(index):
                        return True
                return False

        return True

    def _has_accepted_child(self, parent_index):
        """递归检查父索引下是否有任何子节点通过过滤"""
        model = self.sourceModel()
        for row in range(model.rowCount(parent_index)):
            child_index = model.index(row, 0, parent_index)
            if self.filterAcceptsRow(row, parent_index):
                return True
            # 如果子节点有子节点，继续递归
            if model.hasChildren(child_index):
                if self._has_accepted_child(child_index):
                    return True
        return False

# ==================== 主窗口 ====================
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.current_lang = 'zh'  # 默认中文
        self.root_path = None
        self.file_map = {}
        self.selected_paths = []
        self.ext_list = []
        self._updating = False

        self.setup_ui()
        self.apply_dark_theme()
        self.retranslate_ui()

    def setup_ui(self):
        self.setWindowTitle(STRINGS[self.current_lang]['window_title'])
        self.resize(1000, 700)

        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)

        # ===== 左侧扩展名面板 =====
        left_panel = QWidget()
        left_panel.setMaximumWidth(200)
        left_layout = QVBoxLayout(left_panel)

        self.ext_filter_label = QLabel()
        left_layout.addWidget(self.ext_filter_label)

        self.ext_list_widget = QListWidget()
        self.ext_list_widget.setSelectionMode(QAbstractItemView.NoSelection)
        left_layout.addWidget(self.ext_list_widget)

        main_layout.addWidget(left_panel)

        # ===== 右侧主区域 =====
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)

        # 文件夹选择和语言切换行
        top_layout = QHBoxLayout()
        self.path_label = QLabel()
        self.path_label.setWordWrap(True)
        self.choose_btn = QPushButton()
        self.choose_btn.clicked.connect(self.choose_folder)

        self.lang_combo = QComboBox()
        self.lang_combo.addItems(['中文', 'English'])
        self.lang_combo.currentIndexChanged.connect(self.on_language_changed)

        top_layout.addWidget(self.path_label, 1)
        top_layout.addWidget(self.choose_btn)
        top_layout.addWidget(QLabel(STRINGS[self.current_lang]['language']))
        top_layout.addWidget(self.lang_combo)
        right_layout.addLayout(top_layout)

        # 搜索框
        search_layout = QHBoxLayout()
        self.search_label = QLabel("🔎")
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText(STRINGS[self.current_lang]['search_placeholder'])
        self.search_edit.textChanged.connect(self.on_search_text_changed)
        search_layout.addWidget(self.search_label)
        search_layout.addWidget(self.search_edit)
        right_layout.addLayout(search_layout)

        # 垂直分割器
        splitter = QSplitter(Qt.Vertical)

        # 文件树区域
        tree_widget = QWidget()
        tree_layout = QVBoxLayout(tree_widget)
        tree_layout.setContentsMargins(0, 0, 0, 0)
        self.tree_label = QLabel()
        tree_layout.addWidget(self.tree_label)

        self.tree_view = QTreeView()
        self.tree_view.setHeaderHidden(True)
        self.tree_model = QStandardItemModel()
        self.proxy_model = FileFilterProxy()
        self.proxy_model.setSourceModel(self.tree_model)
        self.tree_view.setModel(self.proxy_model)
        self.tree_view.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.tree_view.setSelectionMode(QAbstractItemView.NoSelection)
        tree_layout.addWidget(self.tree_view)
        splitter.addWidget(tree_widget)

        # 输出区域
        output_widget = QWidget()
        output_layout = QVBoxLayout(output_widget)
        output_layout.setContentsMargins(0, 0, 0, 0)

        # 按钮栏
        info_layout = QHBoxLayout()
        self.size_label = QLabel()
        self.generate_btn = QPushButton()
        self.generate_btn.clicked.connect(self.generate_markdown)
        self.copy_btn = QPushButton()
        self.copy_btn.clicked.connect(self.copy_to_clipboard)
        self.export_btn = QPushButton()
        self.export_btn.clicked.connect(self.export_markdown)
        info_layout.addWidget(self.size_label, 1)
        info_layout.addWidget(self.generate_btn)
        info_layout.addWidget(self.copy_btn)
        info_layout.addWidget(self.export_btn)
        output_layout.addLayout(info_layout)

        self.output_edit = QTextEdit()
        self.output_edit.setReadOnly(True)
        self.output_edit.setFont(QFont("Courier New", 10))
        output_layout.addWidget(self.output_edit)
        splitter.addWidget(output_widget)

        splitter.setSizes([400, 200])
        right_layout.addWidget(splitter)
        main_layout.addWidget(right_panel, 1)

        # 信号连接
        self.ext_list_widget.itemChanged.connect(self.on_extension_filter_changed)
        self.tree_model.itemChanged.connect(self.on_item_changed)

        self.progress_dlg = None

    def apply_dark_theme(self):
        QApplication.setStyle('Fusion')
        palette = QPalette()
        palette.setColor(QPalette.Window, QColor(13, 17, 23))
        palette.setColor(QPalette.WindowText, QColor(201, 209, 217))
        palette.setColor(QPalette.Base, QColor(22, 27, 34))
        palette.setColor(QPalette.AlternateBase, QColor(30, 36, 44))
        palette.setColor(QPalette.ToolTipBase, QColor(22, 27, 34))
        palette.setColor(QPalette.ToolTipText, QColor(201, 209, 217))
        palette.setColor(QPalette.Text, QColor(201, 209, 217))
        palette.setColor(QPalette.Button, QColor(33, 38, 45))
        palette.setColor(QPalette.ButtonText, QColor(201, 209, 217))
        palette.setColor(QPalette.BrightText, Qt.red)
        palette.setColor(QPalette.Highlight, QColor(31, 111, 235))
        palette.setColor(QPalette.HighlightedText, Qt.white)
        self.setPalette(palette)

        font = QFont()
        if sys.platform == 'win32':
            font.setFamily('Microsoft YaHei')
        else:
            font.setFamily('Segoe UI')
        font.setPointSize(10)
        QApplication.setFont(font)

        # 增大按钮样式
        self.setStyleSheet("""
            QTreeView {
                background-color: #161b22;
                alternate-background-color: #1e242c;
                color: #c9d1d9;
                selection-background-color: #1f6feb;
                selection-color: white;
                border: none;
            }
            QTreeView::item:hover {
                background-color: #2d333b;
            }
            QListWidget {
                background-color: #161b22;
                color: #c9d1d9;
                border: 1px solid #30363d;
                outline: none;
            }
            QListWidget::item:hover {
                background-color: #2d333b;
            }
            QTextEdit {
                background-color: #0d1117;
                color: #c9d1d9;
                border: 1px solid #30363d;
                font-family: 'Courier New', monospace;
            }
            QPushButton {
                background-color: #21262d;
                color: #c9d1d9;
                border: 1px solid #30363d;
                padding: 8px 16px;   /* 调大按钮 */
                font-size: 11pt;
                border-radius: 4px;
            }
            QPushButton:hover {
                background-color: #30363d;
                border-color: #8b949e;
            }
            QPushButton:pressed {
                background-color: #3d444d;
            }
            QPushButton:disabled {
                background-color: #161b22;
                color: #6e7681;
            }
            QLineEdit {
                background-color: #161b22;
                color: #c9d1d9;
                border: 1px solid #30363d;
                padding: 4px;
                border-radius: 4px;
            }
            QLabel {
                color: #c9d1d9;
            }
            QComboBox {
                background-color: #21262d;
                color: #c9d1d9;
                border: 1px solid #30363d;
                padding: 4px;
                border-radius: 4px;
            }
            QComboBox::drop-down {
                border: none;
            }
            QComboBox::down-arrow {
                image: none;
                border-left: 4px solid transparent;
                border-right: 4px solid transparent;
                border-top: 4px solid #c9d1d9;
                width: 0;
                height: 0;
            }
        """)

    def retranslate_ui(self):
        """更新界面文本"""
        s = STRINGS[self.current_lang]
        self.setWindowTitle(s['window_title'])
        self.ext_filter_label.setText(s['ext_filter'])
        self.tree_label.setText(s['file_tree'])
        self.choose_btn.setText(s['choose_folder'])
        self.path_label.setText(s['no_folder'] if not self.root_path else self.root_path)
        self.generate_btn.setText(s['generate'])
        self.copy_btn.setText(s['copy'])
        self.export_btn.setText(s['export'])
        self.search_edit.setPlaceholderText(s['search_placeholder'])
        self.size_label.setText(s['size_label'].format("0 B"))
        # 更新按钮状态等

    def on_language_changed(self, index):
        self.current_lang = 'zh' if index == 0 else 'en'
        self.retranslate_ui()

    # ---------- 文件夹选择 ----------
    def choose_folder(self):
        folder = QFileDialog.getExistingDirectory(self, STRINGS[self.current_lang]['choose_folder'])
        if not folder:
            return
        self.root_path = folder
        self.path_label.setText(folder)
        self.start_scan()

    def start_scan(self):
        self.progress_dlg = QProgressDialog(STRINGS[self.current_lang]['scanning'], None, 0, 0, self)
        self.progress_dlg.setWindowModality(Qt.WindowModal)
        self.progress_dlg.show()

        self.scan_thread = ScanThread(self.root_path)
        self.scan_thread.finished_scan.connect(self.on_scan_finished)
        self.scan_thread.start()

    def on_scan_finished(self, file_map, extensions):
        self.progress_dlg.close()
        self.file_map = file_map
        self.ext_list = extensions

        self.tree_model.clear()
        self.ext_list_widget.clear()

        self.build_tree_model()

        for ext in extensions:
            item = QListWidgetItem(ext)
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Checked)
            self.ext_list_widget.addItem(item)

        self.proxy_model.set_allowed_extensions(extensions)

    def build_tree_model(self):
        root_name = os.path.basename(self.root_path)
        root_item = QStandardItem(root_name + '/')
        root_item.setEditable(False)
        root_item.setCheckable(True)
        root_item.setData(None, Qt.UserRole)
        self.tree_model.appendRow(root_item)

        path_to_item = {'': root_item}

        all_paths = list(self.file_map.keys())
        dirs = set()
        for p in all_paths:
            parts = p.split('/')
            for i in range(1, len(parts)):
                dir_path = '/'.join(parts[:i])
                dirs.add(dir_path)

        for d in sorted(dirs, key=lambda x: (x.count('/'), x)):
            if d in path_to_item:
                continue
            parts = d.split('/')
            parent_path = '/'.join(parts[:-1])
            parent_item = path_to_item.get(parent_path, root_item)
            dir_item = QStandardItem(parts[-1] + '/')
            dir_item.setEditable(False)
            dir_item.setCheckable(True)
            dir_item.setData(None, Qt.UserRole)
            parent_item.appendRow(dir_item)
            path_to_item[d] = dir_item

        for rel_path, (abs_path, size) in self.file_map.items():
            parts = rel_path.split('/')
            parent_path = '/'.join(parts[:-1])
            parent_item = path_to_item.get(parent_path, root_item)
            file_name = parts[-1]
            display_text = f"{file_name} ({format_bytes(size)})"
            file_item = QStandardItem(display_text)
            file_item.setEditable(False)
            file_item.setCheckable(True)
            file_item.setData(get_extension(rel_path), Qt.UserRole)
            file_item.setData(rel_path, Qt.UserRole + 1)
            file_item.setData(size, Qt.UserRole + 2)
            parent_item.appendRow(file_item)

        self.tree_view.expandToDepth(1)

    # ---------- 扩展名筛选 ----------
    def on_extension_filter_changed(self, item):
        allowed = []
        for i in range(self.ext_list_widget.count()):
            it = self.ext_list_widget.item(i)
            if it.checkState() == Qt.Checked:
                allowed.append(it.text())
        self.proxy_model.set_allowed_extensions(allowed if allowed else None)

    # ---------- 搜索 ----------
    def on_search_text_changed(self, text):
        self.proxy_model.set_search_text(text)

    # ---------- 手动维护父子节点状态 ----------
    def on_item_changed(self, item):
        if self._updating:
            return
        self._updating = True

        if item.hasChildren():
            self._set_children_state(item, item.checkState())

        parent = item.parent()
        if parent:
            self._update_parent_tristate(parent)
        else:
            root = self.tree_model.invisibleRootItem()
            self._update_parent_tristate(root)

        self.update_selected_size()
        self._updating = False

    def _set_children_state(self, parent_item, state):
        for row in range(parent_item.rowCount()):
            child = parent_item.child(row)
            if child.isCheckable():
                child.setCheckState(state)
            if child.hasChildren():
                self._set_children_state(child, state)

    def _update_parent_tristate(self, parent_item):
        if not parent_item.hasChildren():
            return

        checked_count = 0
        unchecked_count = 0
        partially_count = 0
        total = 0

        for row in range(parent_item.rowCount()):
            child = parent_item.child(row)
            if not child.isCheckable():
                continue
            total += 1
            state = child.checkState()
            if state == Qt.Checked:
                checked_count += 1
            elif state == Qt.Unchecked:
                unchecked_count += 1
            else:
                partially_count += 1

        if total == 0:
            return

        if partially_count > 0 or (checked_count > 0 and unchecked_count > 0):
            new_state = Qt.PartiallyChecked
        elif checked_count == total:
            new_state = Qt.Checked
        else:
            new_state = Qt.Unchecked

        if parent_item.checkState() != new_state:
            parent_item.setCheckState(new_state)

        grand_parent = parent_item.parent()
        if grand_parent:
            self._update_parent_tristate(grand_parent)
        else:
            root = self.tree_model.invisibleRootItem()
            if root != parent_item:
                self._update_parent_tristate(root)

    def update_selected_size(self):
        total = 0
        self.selected_paths = []
        root = self.tree_model.invisibleRootItem()
        total = self._accumulate_selected(root, self.selected_paths)
        s = STRINGS[self.current_lang]
        self.size_label.setText(s['size_label'].format(format_bytes(total)))

    def _accumulate_selected(self, parent_item, paths):
        total = 0
        for row in range(parent_item.rowCount()):
            child = parent_item.child(row)
            if child.hasChildren():
                total += self._accumulate_selected(child, paths)
            else:
                if child.checkState() == Qt.Checked:
                    size = child.data(Qt.UserRole + 2)
                    total += size
                    rel_path = child.data(Qt.UserRole + 1)
                    if rel_path:
                        paths.append(rel_path)
        return total

    # ---------- 生成 Markdown ----------
    def generate_markdown(self):
        s = STRINGS[self.current_lang]
        if not self.selected_paths:
            QMessageBox.warning(self, s['warning'], s['no_selection'])
            return

        sensitive = [p for p in self.selected_paths if any(k in p.lower() for k in SENSITIVE_KEYWORDS)]
        if sensitive:
            msg = s['sensitive_warning'].format("\n".join(sensitive[:5]))
            reply = QMessageBox.question(self, s['warning'], msg,
                                         QMessageBox.Yes | QMessageBox.No)
            if reply != QMessageBox.Yes:
                return

        self.progress_dlg = QProgressDialog(s['generating'], None, 0, 0, self)
        self.progress_dlg.setWindowModality(Qt.WindowModal)
        self.progress_dlg.show()

        self.gen_thread = GenerateThread(
            self.root_path,
            self.selected_paths,
            self.file_map,
            self.current_lang
        )
        self.gen_thread.progress.connect(self.on_generate_progress)
        self.gen_thread.result.connect(self.on_generate_finished)
        self.gen_thread.start()

    def on_generate_progress(self, msg):
        if self.progress_dlg:
            self.progress_dlg.setLabelText(msg)

    def on_generate_finished(self, markdown):
        self.progress_dlg.close()
        self.output_edit.setPlainText(markdown)

        # Token 估算与警告
        token_count = estimate_tokens(markdown)
        s = STRINGS[self.current_lang]
        if token_count > 128000:  # 约 128k 阈值
            msg = s['token_warning'].format(token_count)
            reply = QMessageBox.warning(self, s['warning'], msg,
                                        QMessageBox.Yes | QMessageBox.No)
            # 即使警告，内容已生成，不阻止用户复制/导出

    # ---------- 复制/导出 ----------
    def copy_to_clipboard(self):
        text = self.output_edit.toPlainText()
        s = STRINGS[self.current_lang]
        if not text.strip():
            QMessageBox.warning(self, s['warning'], s['no_selection'])
            return
        clipboard = QApplication.clipboard()
        clipboard.setText(text)
        QMessageBox.information(self, s['copy_success'], s['copy_success'])

    def export_markdown(self):
        text = self.output_edit.toPlainText()
        s = STRINGS[self.current_lang]
        if not text.strip():
            QMessageBox.warning(self, s['warning'], s['no_selection'])
            return
        default_name = f"{os.path.basename(self.root_path) if self.root_path else 'project'}.md"
        file_path, _ = QFileDialog.getSaveFileName(
            self, s['export'], default_name, "Markdown (*.md)"
        )
        if file_path:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(text)
            QMessageBox.information(self, s['export_success'], s['export_success'].format(file_path))

# ==================== 启动 ====================
if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())