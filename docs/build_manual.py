# -*- coding: utf-8 -*-
"""生成《云栖盘 使用说明书.docx》"""
import os
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()

# ── 全局字体：西文 Calibri，中文 微软雅黑 ──
def set_fonts(style, size=None, bold=None, color=None):
    style.font.name = 'Calibri'
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.get_or_add_rFonts()
    rfonts.set(qn('w:eastAsia'), '微软雅黑')
    if size is not None:
        style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    if color is not None:
        style.font.color.rgb = RGBColor(*color)

set_fonts(doc.styles['Normal'], size=10.5)
for sname in ['Heading 1', 'Heading 2', 'Heading 3', 'Title', 'List Bullet']:
    try:
        st = doc.styles[sname]
        rpr = st.element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        rfonts.set(qn('w:eastAsia'), '微软雅黑')
    except KeyError:
        pass
set_fonts(doc.styles['Heading 1'], size=16, bold=True, color=(0x0E, 0x6B, 0xD8))
set_fonts(doc.styles['Heading 2'], size=13, bold=True, color=(0x1F, 0x29, 0x33))
set_fonts(doc.styles['Heading 3'], size=11.5, bold=True, color=(0x37, 0x41, 0x51))

def p(text, bold=False, style=None):
    par = doc.add_paragraph(style=style)
    run = par.add_run(text)
    run.bold = bold
    return par

def bullet(text):
    return p(text, style='List Bullet')

def table(headers, rows, widths=None):
    t = doc.add_table(rows=1 + len(rows), cols=len(headers))
    t.style = 'Light Grid Accent 1'
    for i, h in enumerate(headers):
        cell = t.rows[0].cells[i]
        cell.text = h
        for run in cell.paragraphs[0].runs:
            run.bold = True
    for r, row in enumerate(rows, start=1):
        for c, val in enumerate(row):
            t.rows[r].cells[c].text = str(val)
    if widths:
        for c, w in enumerate(widths):
            for row in t.rows:
                row.cells[c].width = Cm(w)
    return t

# ═══════════════ 封面 ═══════════════
title = doc.add_heading('云栖盘 使用说明书', level=0)
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = sub.add_run('版本 1.0 · 2026 年 11 月 · 适用于 Windows 10+ / macOS 12+')
r.font.size = Pt(11)
r.font.color.rgb = RGBColor(0x7B, 0x87, 0x94)
doc.add_paragraph()

# ═══════════════ 1 简介 ═══════════════
doc.add_heading('一、软件简介', level=1)
p('云栖盘是一款「私有云盘 + 下载加速」双能力桌面软件：')
bullet('私有云盘：自带服务端，文件上传/下载/预览/分享/同步全部掌握在自己手里，速度只受你本地带宽与服务器带宽限制，无任何平台限速；')
bullet('下载加速：统一传输队列 + 自研多线程分块下载内核（单文件最高 32 线程、动态块大小、断点续传），并支持通过官方直链/cURL 导入方式加速下载；')
bullet('免登录使用：本地单用户模式，打开即用，自动创建本地账号，无需注册与登录。')

# ═══════════════ 2 快速开始 ═══════════════
doc.add_heading('二、快速开始', level=1)
doc.add_heading('2.1 推荐方式：一键启动器', level=2)
p('在项目根目录（即本说明书所在 docs 目录的上一级）双击以下文件之一：')
bullet('start.bat —— 完整启动：环境体检 → 启动依赖容器（数据库/缓存/对象存储）→ 启动服务端 → 提示服务端地址。服务端已运行时自动跳过。')
bullet('启动云栖盘.cmd —— 日常使用首选：自动探测服务端（不在线会自动拉起）→ 启动客户端 → 确认窗口已出现。全程有日志与状态提示，任何异常都会显示原因。')
p('启动过程请勿按 Ctrl+C 中断：依赖容器冷启动需要几十秒属正常现象（窗口会显示进度）。')
doc.add_heading('2.2 绿色版（免安装）', level=2)
p('解压 client\\dist\\yunqipan-1.0.0-win-绿色版.zip 后，双击目录内的「启动云栖盘.cmd」（注意：是 cmd 文件，不是 exe）。用户数据自动保存在该目录的 profile 子目录，整个文件夹拷走即完成迁移。')
doc.add_heading('2.3 安装包 / 便携版', level=2)
p('client\\dist 目录下另提供 NSIS 安装包（yunqipan-1.0.0-x64-setup.exe）与便携版（yunqipan-1.0.0-portable.exe），均已完成代码签名（本机开发证书）。安装包报错时：右键属性 → 解除锁定；SmartScreen 提示选择「更多信息 → 仍要运行」。')
doc.add_heading('2.4 首次打开', level=2)
p('客户端启动后会自动连接服务端并创建本地账号，直接进入文件页。若弹出「连接页」，说明服务端未启动或地址不对：确认服务端已启动（start.bat），在连接页填写正确地址后点击「连接 / 重试」。')

# ═══════════════ 3 界面导览 ═══════════════
doc.add_heading('三、界面导览', level=1)
bullet('顶栏：logo、搜索框（本地过滤当前目录文件名）、「上传」按钮、主题切换、头像菜单（配额概览 / 主题 / 设置）；')
bullet('左侧导航：文件 / 传输 / 分享 / 同步 / 设置 五个页面；')
bullet('文件区：面包屑导航、文件列表（彩色类型图标）、行悬停操作（预览/下载/分享/重命名/删除）、多选批量操作；')
bullet('底部状态栏：左侧配额进度条（已用/总量），右侧实时传输摘要（下载/上传速度、任务数），点击直达传输页。')

# ═══════════════ 4 文件管理 ═══════════════
doc.add_heading('四、文件管理', level=1)
bullet('上传：点击「上传」选择文件，或直接把文件/文件夹拖进窗口；支持多选批量上传；')
bullet('下载：行内「⬇」按钮或批量下载；下载位置在「设置 → 下载目录」；')
bullet('目录：新建文件夹、单击文件夹名进入、面包屑逐级返回；')
bullet('整理：行内重命名（✏）、删除（🗑，删除需确认；目录删除为整树删除）；')
bullet('预览：支持图片/视频/音频/文本/PDF 等格式在线预览（加密文件不参与预览）；')
bullet('断点续传：上传按 8 MiB 分块（已传分块零重传），下载按块记录进度，网络中断或重启后自动续传，文件不损坏。')

# ═══════════════ 5 传输中心 ═══════════════
doc.add_heading('五、传输中心', level=1)
bullet('所有任务（上传/下载/链接下载）统一排队展示：文件名、进度、实时速度、状态；')
bullet('任务操作：暂停 / 继续 / 取消 / 重试 / 打开所在目录；支持「全部暂停/继续」「清空已完成」；')
bullet('并发与线程：同时任务数、单文件线程数（1~32）在「设置」中调整；')
bullet('崩溃恢复：程序异常退出后，重启时未完成任务自动恢复为暂停状态（可自动继续），续传精确到块。')

# ═══════════════ 6 分享 ═══════════════
doc.add_heading('六、分享功能', level=1)
doc.add_heading('6.1 创建分享', level=2)
p('分享页 → 新建分享 → 选择文件或文件夹 → 可选设置：提取码（4-8 位）、有效期（小时）、下载次数上限。生成形如 http://服务端/s/xxxxxxxx 的链接。')
bullet('文件夹分享：对方可浏览目录结构、按需下载单个文件；')
bullet('提取码仅以哈希形式存储，服务端不保存明文；')
bullet('下载次数按「新下载」计数，断点续传不会重复消耗次数。')
doc.add_heading('6.2 接收分享', level=2)
p('把收到的 /s/ 链接粘贴到顶栏解析框 → 解析 → 勾选文件 → 加入下载队列即可。带提取码的链接按提示输入。')

# ═══════════════ 7 链接解析与下载加速 ═══════════════
doc.add_heading('七、链接解析与下载加速', level=1)
doc.add_heading('7.1 支持解析的内容', level=2)
bullet('http(s):// 公开直链（自动探测大小、Range 支持）；')
bullet('云栖盘分享链接（/s/ 开头）；')
bullet('浏览器「复制为 cURL(bash)」命令（推荐，见 7.2）。')
doc.add_heading('7.2 cURL 导入教程（以网盘下载整合包为例）', level=2)
p('场景：资源只能在百度/夸克网盘下载且官方速度慢。云栖盘可在合规前提下，把你「自己登录会话」的官方下载请求用多线程跑得更快：')
p('1. 用浏览器登录官方网页版，点击下载，让下载开始；')
p('2. 按 F12 打开开发者工具 → 切到 Network（网络）面板；')
p('3. 找到正在下载的请求（体积最大、类型为 application/octet-stream 或 media，百度通常在 d.pcs.baidu.com 域名）；')
p('4. 右键该请求 → 复制 → 复制为 cURL(bash)；')
p('5. 粘贴到云栖盘顶栏解析框 → 解析（自动提取下载地址、Referer、Cookie 与文件名）；')
p('6. 选择保存位置、线程数（建议 32）→ 加入下载队列，开始多线程下载。')
p('注意：官方直链有时效（通常几分钟），失效后重复第 3~4 步重新复制；提速效果取决于平台限速策略（按连接限速提升明显，账号级限速提升有限）。')
doc.add_heading('7.3 百度/夸克公开分享页解析', level=2)
p('设置在「链接解析器」开启后可解析对应平台的公开分享页。合规说明：仅处理匿名访客可见的公开内容，不实现任何逆向签名、不使用他人账号 Cookie；若平台不提供匿名直链，会提示「请使用官方客户端」——此时请改用 7.2 的 cURL 导入方式加速。')

# ═══════════════ 8 本地同步 ═══════════════
doc.add_heading('八、本地同步', level=1)
bullet('选择本地目录与同步模式：双向同步 / 仅上传（本地→云端）/ 仅下载（云端→本地）；')
bullet('远端扫描间隔（默认 30 秒）、排除规则（支持 * 通配符，如 *.tmp、node_modules）；')
bullet('冲突处理：两侧都变化时，本地文件自动改名为「原名 (conflict 时间戳)」保留两份；')
bullet('同步产生的上传/下载任务进入统一传输队列，同样支持断点续传。')

# ═══════════════ 9 设置中心 ═══════════════
doc.add_heading('九、设置中心', level=1)
table(
    ['设置项', '说明'],
    [
        ['下载目录', '下载任务的默认保存位置'],
        ['缓存目录', 'aria2 缓存与临时文件（程序管理）'],
        ['主题', '浅色 / 深色'],
        ['同时上传任务数 / 下载任务数', '传输队列的并发上限（1~16）'],
        ['单文件下载线程数', '1~32，建议 8~16；直链加速可拉满 32'],
        ['下载/上传限速', 'KB/s，0 表示不限速'],
        ['上传分块大小', '5~64 MiB，默认 8 MiB（越大越省请求，越小越细粒度续传）'],
        ['aria2 加速内核', '可选：安装 aria2c 后启用；未启用时使用自研多线程内核'],
        ['链接解析器', '百度/夸克公开分享页解析开关（默认关闭，合规提示见 7.3）'],
        ['E2E 加密', '新上传文件默认加密（见第十章）'],
    ],
    widths=[6, 10],
)

# ═══════════════ 10 E2E 加密 ═══════════════
doc.add_heading('十、端到端加密（E2E）', level=1)
bullet('AES-256-GCM 流式加密，口令仅保存在本机客户端，服务端只存密文；')
bullet('加密文件不参与在线预览；解密在下载时由客户端完成；')
bullet('分享加密文件时，需要线下把口令告诉对方。')

# ═══════════════ 11 FAQ ═══════════════
doc.add_heading('十一、常见问题（FAQ）', level=1)
table(
    ['问题', '处理办法'],
    [
        ['双击 start.bat / 启动器窗口一闪而过', '重新双击（新版不会再闪退）：窗口会显示完整过程并停留；日志在 logs\\start.log 与 logs\\client-launch.log'],
        ['双击 exe 没有反应', '本机需以 --no-sandbox 参数启动客户端。请使用启动器（start.bat / 启动云栖盘.cmd / 绿色版目录内的 启动云栖盘.cmd），不要直接双击 云栖盘.exe'],
        ['浏览器打开服务端地址显示 404', '正常现象：根路径只显示状态页，接口都在 /api/v1/ 下，客户端自动使用，无需手动访问'],
        ['登录页说服务端地址不对', '服务端默认 8080；若被其他程序占用会自动改用 8081 等端口，以启动器输出提示的端口为准'],
        ['解析百度分享链接提示「请使用官方客户端」', '平台不提供匿名直链（合规要求不能绕过）。请按 7.2 用 cURL 导入方式加速'],
        ['下载中途断网/关机', '重启后打开客户端即可：任务自动恢复并续传（上传按 8MiB 分块、下载按控制文件精确续传）'],
        ['数据存在哪里', '客户端配置与账号：绿色版在 profile 目录，启动器模式在 .runtime\\profile；文件实体与元数据在服务端（Docker 容器，对象存储 + PostgreSQL）'],
        ['如何备份', '服务端执行 docker compose down 后再备份容器数据卷即可（详见部署文档 docs/03-deployment.md）'],
    ],
    widths=[7, 9],
)

# ═══════════════ 12 合规声明 ═══════════════
doc.add_heading('十二、合规声明', level=1)
p('本软件不包含任何破解、反编译、绕过平台鉴权或篡改官方客户端的功能。链接解析仅处理匿名访客可见的公开内容；cURL 导入仅使用用户自己登录会话发出的官方下载请求，凭据仅用于本次下载且不保存。请遵守所在地区法律法规与所使用平台的服务条款。')

doc.add_paragraph()
footer = doc.add_paragraph()
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = footer.add_run('—— 云栖盘 · 属于你的私有云 ——')
r.font.size = Pt(10)
r.font.color.rgb = RGBColor(0x7B, 0x87, 0x94)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '云栖盘使用说明书.docx')
doc.save(out)
print('saved:', out)
