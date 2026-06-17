"""
为 403家庭管家 生成符合 macOS 规范的应用图标套件
- 源图：1024×1024 PNG（无圆角，深色品牌背景，猫咪内缩安全区 72%）
- 输出：icon-cat-source.png, icon-cat.png (512), icon-cat.icns, icon-cat.ico
"""

from PIL import Image, ImageDraw, ImageFilter
import os
import struct
import io

BUILD_DIR = os.path.join(os.path.dirname(__file__), "..", "build")
SRC_PATH = os.path.join(BUILD_DIR, "icon-cat-source.png")
OUT_SOURCE = os.path.join(BUILD_DIR, "icon-cat-source.png")
OUT_PNG512 = os.path.join(BUILD_DIR, "icon-cat.png")
OUT_ICNS   = os.path.join(BUILD_DIR, "icon-cat.icns")
OUT_ICO    = os.path.join(BUILD_DIR, "icon-cat.ico")

CANVAS = 1024
SAFE_RATIO = 0.72          # 猫咪占画面 72%（安全区内缩）
CAT_PX = int(CANVAS * SAFE_RATIO)  # 737px

# ── 颜色方案（纯黑白线条，无填充色）───────────────────────
BG_COLOR  = (255, 255, 255)  # 纯白背景
# 猫咪线稿保持原图黑色，不做颜色转换


def make_vertical_gradient(size, top, bot):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        r = int(top[0] + (bot[0] - top[0]) * y / size)
        g = int(top[1] + (bot[1] - top[1]) * y / size)
        b = int(top[2] + (bot[2] - top[2]) * y / size)
        draw.line([(0, y), (size, y)], fill=(r, g, b))
    return img


def extract_line_art(img, line_color):
    """
    把黑线稿（白底）转为指定颜色线稿（透明底）
    使用 getdata/putdata 批量处理，速度远快于逐像素循环
    """
    img = img.convert("RGBA")
    pixels = img.getdata()
    out_pixels = []
    for r, g, b, a in pixels:
        luminance = 0.299 * r + 0.587 * g + 0.114 * b
        alpha = max(0, min(255, int(255 - luminance)))
        out_pixels.append((*line_color, alpha) if alpha > 8 else (0, 0, 0, 0))
    out = Image.new("RGBA", img.size)
    out.putdata(out_pixels)
    return out


def build_source_image():
    # 1. 加载原图
    cat_src = Image.open(SRC_PATH).convert("RGBA")
    print(f"原始尺寸: {cat_src.size}")

    # 2. 裁剪出猫咪内容区域（去除多余白边）——用 getdata 快速扫描
    pixels = cat_src.getdata()
    w, h = cat_src.size
    min_x, min_y, max_x, max_y = w, h, 0, 0
    for idx, (r, g, b, _) in enumerate(pixels):
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum < 245:
            y, x = divmod(idx, w)
            if x < min_x: min_x = x
            if y < min_y: min_y = y
            if x > max_x: max_x = x
            if y > max_y: max_y = y
    bbox = (max(0, min_x - 4), max(0, min_y - 4),
            min(w, max_x + 4), min(h, max_y + 4))
    cat_cropped = cat_src.crop(bbox)
    print(f"裁剪后猫咪区域: {bbox} → {cat_cropped.size}")

    # 3. 缩放猫咪至安全区尺寸（保留原始黑色线稿，不做颜色处理）
    cat_art = cat_cropped.resize((CAT_PX, CAT_PX), Image.LANCZOS)
    print(f"缩放后猫咪: {CAT_PX}×{CAT_PX}px")

    # 4. 纯白背景画布
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (*BG_COLOR, 255))

    # 5. 粘贴猫咪线稿（居中，保留原始黑色）
    offset = (CANVAS - CAT_PX) // 2
    canvas.paste(cat_art, (offset, offset), cat_art)

    return canvas.convert("RGB")


def write_icns(img, out_path):
    """
    生成 macOS .icns（使用 sips 更可靠，这里用 Pillow + iconutil 方式）
    回退方案：直接用 sips 或 iconutil
    """
    # 使用 iconutil 方法：先生成 iconset 目录
    import tempfile, shutil, subprocess

    sizes = [
        (16,   "icon_16x16.png"),
        (32,   "icon_16x16@2x.png"),
        (32,   "icon_32x32.png"),
        (64,   "icon_32x32@2x.png"),
        (128,  "icon_128x128.png"),
        (256,  "icon_128x128@2x.png"),
        (256,  "icon_256x256.png"),
        (512,  "icon_256x256@2x.png"),
        (512,  "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]

    tmpdir = tempfile.mkdtemp()
    iconset = os.path.join(tmpdir, "icon.iconset")
    os.makedirs(iconset)

    for sz, fname in sizes:
        resized = img.resize((sz, sz), Image.LANCZOS)
        resized.save(os.path.join(iconset, fname), "PNG")

    # 调用 iconutil 打包
    result = subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", out_path],
        capture_output=True, text=True
    )
    shutil.rmtree(tmpdir)
    if result.returncode == 0:
        print(f"✓ icns 已生成: {out_path}")
    else:
        print(f"✗ iconutil 失败: {result.stderr}")


def write_ico(img, out_path):
    """生成 Windows .ico（含 16/32/48/64/128/256px）"""
    ico_sizes = [16, 32, 48, 64, 128, 256]
    imgs = [img.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    imgs[0].save(
        out_path, format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=imgs[1:]
    )
    print(f"✓ ico 已生成: {out_path}")


def main():
    print("── 生成 403家庭管家 应用图标 ──")
    print(f"画布: {CANVAS}×{CANVAS}px | 安全区: {SAFE_RATIO*100:.0f}% ({CAT_PX}px)")

    source = build_source_image()

    # 保存源图 1024×1024
    source.save(OUT_SOURCE, "PNG", optimize=True)
    print(f"✓ 源图已保存: {OUT_SOURCE}")

    # 保存 512px PNG（运行时窗口图标）
    png512 = source.resize((512, 512), Image.LANCZOS)
    png512.save(OUT_PNG512, "PNG", optimize=True)
    print(f"✓ 512px PNG 已保存: {OUT_PNG512}")

    # 生成 .icns
    write_icns(source, OUT_ICNS)

    # 生成 .ico
    write_ico(source, OUT_ICO)

    print("\n── 全部完成 ──")


if __name__ == "__main__":
    main()
