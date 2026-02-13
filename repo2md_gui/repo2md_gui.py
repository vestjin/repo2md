import sys
import os
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTreeView, QTextEdit, QLabel, QMessageBox,
    QFileDialog, QListWidget, QListWidgetItem, QProgressDialog,
    QAbstractItemView, QSplitter
)
from PySide6.QtCore import Qt, QThread, Signal, QSortFilterProxyModel
from PySide6.QtGui import QStandardItemModel, QStandardItem, QClipboard, QFont, QPalette, QColor

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
            # 跳过隐藏目录
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

    def __init__(self, root_path, selected_paths, file_map):
        super().__init__()
        self.root_path = root_path
        self.selected_paths = selected_paths
        self.file_map = file_map

    def run(self):
        lines = []
        root_name = os.path.basename(self.root_path)

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
                    lines.append(f"### `{rel_path}`\n```\n[二进制文件，已跳过: {reason}]\n```\n")
                    continue

                try:
                    content = read_text_file(abs_path)
                    ext = get_extension(rel_path)
                    lang = ext if ext != '[无后缀]' else ''
                    lines.append(f"### `{rel_path}`\n```{lang}\n{content}\n```\n")
                except Exception as e:
                    lines.append(f"### `{rel_path}`\n```\n[读取失败: {e}]\n```\n")

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

# ==================== 扩展名过滤代理模型 ====================
class ExtensionFilterProxy(QSortFilterProxyModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.allowed_extensions = None

    def set_allowed_extensions(self, exts):
        self.allowed_extensions = set(exts) if exts is not None else None
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row, source_parent):
        if self.allowed_extensions is None:
            return True
        model = self.sourceModel()
        index = model.index(source_row, 0, source_parent)
        ext = model.data(index, Qt.UserRole)
        if ext is None:  # 目录始终显示
            return True
        return ext in self.allowed_extensions

# ==================== 主窗口 ====================
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("repo2md - 项目转Markdown (暗色主题)")
        self.resize(1000, 700)

        # 应用GitHub暗色主题
        self.apply_dark_theme()

        self.root_path = None
        self.file_map = {}
        self.selected_paths = []
        self.ext_list = []
        self._updating = False

        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)

        # ===== 左侧扩展名面板 =====
        left_panel = QWidget()
        left_panel.setMaximumWidth(200)
        left_layout = QVBoxLayout(left_panel)
        left_layout.addWidget(QLabel("🔍 扩展名筛选"))
        self.ext_list_widget = QListWidget()
        self.ext_list_widget.setSelectionMode(QAbstractItemView.NoSelection)
        left_layout.addWidget(self.ext_list_widget)
        main_layout.addWidget(left_panel)

        # ===== 右侧主区域 =====
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)

        # 文件夹选择行
        choose_layout = QHBoxLayout()
        self.path_label = QLabel("未选择文件夹")
        self.path_label.setWordWrap(True)
        self.choose_btn = QPushButton("📁 选择文件夹")
        self.choose_btn.clicked.connect(self.choose_folder)
        choose_layout.addWidget(self.path_label, 1)
        choose_layout.addWidget(self.choose_btn)
        right_layout.addLayout(choose_layout)

        # 垂直分割器
        splitter = QSplitter(Qt.Vertical)

        # 文件树区域
        tree_widget = QWidget()
        tree_layout = QVBoxLayout(tree_widget)
        tree_layout.setContentsMargins(0, 0, 0, 0)
        tree_layout.addWidget(QLabel("📂 项目文件 (勾选所需文件)"))
        self.tree_view = QTreeView()
        self.tree_view.setHeaderHidden(True)
        self.tree_model = QStandardItemModel()
        self.proxy_model = ExtensionFilterProxy()
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
        self.size_label = QLabel("📦 当前选中总大小: 0 B")
        self.generate_btn = QPushButton("生成 Markdown")
        self.generate_btn.clicked.connect(self.generate_markdown)
        self.copy_btn = QPushButton("📋 复制到剪贴板")
        self.copy_btn.clicked.connect(self.copy_to_clipboard)
        self.export_btn = QPushButton("💾 导出为 .md")
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
        """应用GitHub风格的暗色主题"""
        # 使用 Fusion 风格
        QApplication.setStyle('Fusion')

        # 设置调色板（基础）
        palette = QPalette()
        palette.setColor(QPalette.Window, QColor(13, 17, 23))          # #0d1117
        palette.setColor(QPalette.WindowText, QColor(201, 209, 217))  # #c9d1d9
        palette.setColor(QPalette.Base, QColor(22, 27, 34))            # #161b22
        palette.setColor(QPalette.AlternateBase, QColor(30, 36, 44))  # 稍亮
        palette.setColor(QPalette.ToolTipBase, QColor(22, 27, 34))
        palette.setColor(QPalette.ToolTipText, QColor(201, 209, 217))
        palette.setColor(QPalette.Text, QColor(201, 209, 217))
        palette.setColor(QPalette.Button, QColor(33, 38, 45))          # #21262d
        palette.setColor(QPalette.ButtonText, QColor(201, 209, 217))
        palette.setColor(QPalette.BrightText, Qt.red)
        palette.setColor(QPalette.Highlight, QColor(31, 111, 235))     # #1f6feb
        palette.setColor(QPalette.HighlightedText, Qt.white)
        self.setPalette(palette)

        # 设置字体
        font = QFont()
        if sys.platform == 'win32':
            font.setFamily('Microsoft YaHei')
        else:
            font.setFamily('Segoe UI')
        font.setPointSize(10)
        QApplication.setFont(font)

        # 详细样式表微调
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
            QTreeView::branch:has-children:!has-siblings:closed,
            QTreeView::branch:closed:has-children:has-siblings {
                border-image: none;
                image: none;
                background: #161b22;
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
                padding: 5px 12px;
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
            QLabel {
                color: #c9d1d9;
            }
            QProgressDialog {
                background-color: #0d1117;
                color: #c9d1d9;
            }
        """)

    # ---------- 以下功能代码与之前完全相同 ----------
    def choose_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择项目根目录")
        if not folder:
            return
        self.root_path = folder
        self.path_label.setText(folder)
        self.start_scan()

    def start_scan(self):
        self.progress_dlg = QProgressDialog("扫描文件中...", None, 0, 0, self)
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
        root_item.setData(None, Qt.UserRole)  # 目录无扩展名
        self.tree_model.appendRow(root_item)

        path_to_item = {'': root_item}

        # 收集所有目录路径
        all_paths = list(self.file_map.keys())
        dirs = set()
        for p in all_paths:
            parts = p.split('/')
            for i in range(1, len(parts)):
                dir_path = '/'.join(parts[:i])
                dirs.add(dir_path)

        # 添加目录节点
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

        # 添加文件节点
        for rel_path, (abs_path, size) in self.file_map.items():
            parts = rel_path.split('/')
            parent_path = '/'.join(parts[:-1])
            parent_item = path_to_item.get(parent_path, root_item)
            file_name = parts[-1]
            display_text = f"{file_name} ({format_bytes(size)})"
            file_item = QStandardItem(display_text)
            file_item.setEditable(False)
            file_item.setCheckable(True)
            file_item.setData(get_extension(rel_path), Qt.UserRole)   # 扩展名
            file_item.setData(rel_path, Qt.UserRole + 1)              # 相对路径
            file_item.setData(size, Qt.UserRole + 2)                  # 文件大小
            parent_item.appendRow(file_item)

        self.tree_view.expandToDepth(1)

    def on_extension_filter_changed(self, item):
        allowed = []
        for i in range(self.ext_list_widget.count()):
            it = self.ext_list_widget.item(i)
            if it.checkState() == Qt.Checked:
                allowed.append(it.text())
        self.proxy_model.set_allowed_extensions(allowed if allowed else None)

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
        self.size_label.setText(f"📦 当前选中总大小: {format_bytes(total)}")

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

    def generate_markdown(self):
        if not self.selected_paths:
            QMessageBox.warning(self, "提示", "请至少勾选一个文件")
            return

        sensitive = [p for p in self.selected_paths if any(k in p.lower() for k in SENSITIVE_KEYWORDS)]
        if sensitive:
            msg = "选中的文件包含可能敏感的信息：\n" + "\n".join(sensitive[:5])
            msg += "\n\n确定要继续生成吗？"
            reply = QMessageBox.question(self, "敏感文件警告", msg,
                                         QMessageBox.Yes | QMessageBox.No)
            if reply != QMessageBox.Yes:
                return

        self.progress_dlg = QProgressDialog("生成 Markdown 中...", None, 0, 0, self)
        self.progress_dlg.setWindowModality(Qt.WindowModal)
        self.progress_dlg.show()

        self.gen_thread = GenerateThread(
            self.root_path,
            self.selected_paths,
            self.file_map
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

    def copy_to_clipboard(self):
        text = self.output_edit.toPlainText()
        if not text.strip():
            QMessageBox.warning(self, "提示", "没有可复制的内容")
            return
        clipboard = QApplication.clipboard()
        clipboard.setText(text)
        QMessageBox.information(self, "完成", "已复制到剪贴板")

    def export_markdown(self):
        text = self.output_edit.toPlainText()
        if not text.strip():
            QMessageBox.warning(self, "提示", "没有可导出的内容")
            return
        default_name = f"{os.path.basename(self.root_path) if self.root_path else 'project'}.md"
        file_path, _ = QFileDialog.getSaveFileName(
            self, "保存 Markdown 文件", default_name, "Markdown (*.md)"
        )
        if file_path:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(text)
            QMessageBox.information(self, "完成", f"已保存到 {file_path}")

# ==================== 启动 ====================
if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())