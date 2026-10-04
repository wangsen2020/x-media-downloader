"""Rebrand WAExport's "pin the extension" GIF for X Media Downloader.

python pin_gif.py <src guide_pin.gif> <out pin.gif> <extension name as Chrome shows it>

Replaces, frame by frame, the extension row in Chrome's Extensions menu (icon + name) and the
pinned toolbar icon. The mouse cursor is preserved: per background state a per-pixel median
reference is built (the moving cursor drops out), and pixels that differ from that reference
are copied back on top of the replacement.
"""
import sys
from pathlib import Path
from statistics import median
from PIL import Image, ImageDraw, ImageFont, ImageSequence

SRC, OUT, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
HERE = Path(__file__).resolve().parent
ICON = Image.open(HERE.parents[1] / 'icons' / 'icon48.png').convert('RGBA')
FONT = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 14)
MENU_W = 148                  # Chrome elides the name with '...' at about this width
CJK = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 13)
ROW = (46, 167, 238, 193)     # extension row: icon + name (pin button starts ~x=248)
TB = (268, 8, 345, 38)        # toolbar: pinned icon, incl. its slide-in from the puzzle button
TIP = (220, 41, 480, 68)      # hover tooltip under the pinned icon (shows the extension name), incl. its 1px border
TIP_FONT = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 13)

def is_green(p):
    r, g, b = p[:3]
    return g > 110 and g > r + 40 and g > b + 20

def green_count(f, box):
    x0, y0, x1, y1 = box
    return sum(is_green(f.getpixel((x, y))) for x in range(x0, x1) for y in range(y0, y1))

src = Image.open(SRC)
frames, durations = [], []
for fr in ImageSequence.Iterator(src):
    frames.append(fr.convert('RGB').copy())
    durations.append(fr.info.get('duration', 100))

def state(f):
    # row background: white normally, grey while hovered
    p = f.getpixel((ROW[0] + 2, ROW[1] + 2))
    return 'hover' if sum(p) < 735 else 'plain'

def median_ref(fs, box):
    crops = [f.crop(box) for f in fs]
    w, h = crops[0].size
    ref = Image.new('RGB', (w, h))
    data = [list(c.get_flattened_data()) for c in crops]
    ref.putdata([tuple(int(median(d[i][k] for d in data)) for k in range(3)) for i in range(w * h)])
    return ref

menu = [i for i, f in enumerate(frames) if green_count(f, ROW) > 60]
refs = {}
for st in ('plain', 'hover'):
    fs = [frames[i] for i in menu if state(frames[i]) == st]
    if fs:
        refs[st] = median_ref(fs, ROW)

def text_color(ref):
    return min(ref.get_flattened_data(), key=sum)

def new_row(ref):
    w, h = ref.size
    bg = ref.getpixel((2, 2))
    row = Image.new('RGB', (w, h), bg)
    icon = ICON.resize((16, 16), Image.LANCZOS)
    row.paste(icon, (50 - ROW[0] + 1, (h - 16) // 2), icon)
    d = ImageDraw.Draw(row)
    f = pick(FONT, 13)
    d.text((85 - ROW[0], h // 2), elide(NAME, f, MENU_W), font=f, fill=text_color(ref), anchor='lm')
    return row

def pick(font_latin, size):
    return ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', size) if any(ord(c) > 0x2E80 for c in NAME) else font_latin

def elide(text, font, width):
    d = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    if d.textlength(text, font=font) <= width:
        return text
    while text and d.textlength(text.rstrip() + '...', font=font) > width:
        text = text[:-1]
    return text.rstrip() + '...'

rows = {st: new_row(r) for st, r in refs.items()}

def overlay_cursor(orig, ref, repl, thresh=60):
    """Copy back only cursor pixels: near-black outline, or near-white fill over a darker ref.
    Never copy back green (the old WhatsApp icon) or mid-grey (old text fading in)."""
    out = repl.copy()
    o, r, px = orig.load(), ref.load(), out.load()
    for y in range(orig.height):
        for x in range(orig.width):
            a, b = o[x, y], r[x, y]
            if sum(abs(a[k] - b[k]) for k in range(3)) <= thresh or is_green(a):
                continue
            if sum(a) < 200 or (sum(a) > 720 and sum(b) < 600):
                px[x, y] = a
    return out

tb_frames = [i for i, f in enumerate(frames) if green_count(f, TB) > 20]
tb_ref = median_ref([frames[i] for i in tb_frames], TB) if tb_frames else None

# A frame with the same menu/toolbar state but no tooltip, to restore what the old,
# wider tooltip covered.
clean_tip = None
tip_src = next(j for j in range(len(frames) - 1, -1, -1)
               if sum(1 for x in range(TIP[0], TIP[2]) for y in range(TIP[1], TIP[3]) if sum(frames[j].getpixel((x, y))) < 120) < 200)
tip_ref = frames[tip_src].crop(TIP)
out = []
for i, f in enumerate(frames):
    f = f.copy()
    if i in menu:
        st = state(f)
        orig = f.crop(ROW)
        f.paste(overlay_cursor(orig, refs[st], rows[st]), ROW[:2])
    if green_count(f, TB) > 20:
        orig = f.crop(TB)
        xs = [x for x in range(TB[2] - TB[0]) for y in range(TB[3] - TB[1]) if is_green(orig.getpixel((x, y)))]
        ys = [y for x in range(TB[2] - TB[0]) for y in range(TB[3] - TB[1]) if is_green(orig.getpixel((x, y)))]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        size = max(max(xs) - min(xs), max(ys) - min(ys)) + 1
        repl = orig.copy()
        # background of this very frame (the slot turns grey while pressed/hovered)
        bgc = orig.getpixel((max(min(xs) - 2, 0), round(cy)))
        ImageDraw.Draw(repl).rectangle((min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1), fill=bgc)
        icon = ICON.resize((size, size), Image.LANCZOS)
        repl.paste(icon, (round(cx - size / 2 + 0.5), round(cy - size / 2 + 0.5)), icon)
        # While the icon is still sliding out of the puzzle button the old icon sits away from the
        # reference position and its white glyph would leak through; the cursor is elsewhere then.
        settled = abs(TB[0] + cx - 292) <= 3
        f.paste(overlay_cursor(orig, tb_ref, repl) if settled else repl, TB[:2])
    # Tooltip with the old extension name while hovering the pinned icon.
    dark = sum(1 for x in range(TIP[0], TIP[2]) for y in range(TIP[1], TIP[3]) if sum(frames[i].getpixel((x, y))) < 120)
    if dark > 4000:
        if clean_tip is None:
            clean_tip = tip_ref
        has_text = any(sum(frames[i].getpixel((x, y))) > 400 for x in range(330, 470) for y in range(46, 63))
        f.paste(clean_tip, TIP[:2])
        d = ImageDraw.Draw(f)
        tf = pick(TIP_FONT, 12)
        w = round(d.textlength(NAME, font=tf)) + 16
        d.rectangle((221, 42, 221 + w, 66), fill=(30, 30, 30), outline=(200, 200, 200))
        if has_text:
            d.text((230, 54), NAME, font=tf, fill=(230, 230, 230), anchor='lm')
    out.append(f)

# Leftover check: no green WhatsApp pixels may remain anywhere in either slot.
left = [i for i, f in enumerate(out) if green_count(f, ROW) or green_count(f, TB)]
print('frames', len(out), 'menu frames', len(menu), 'toolbar frames', len(tb_frames), 'leftover green frames', left)
pal = [fr.convert('P', palette=Image.Palette.ADAPTIVE, colors=256) for fr in out]
pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=durations, loop=src.info.get('loop', 0), disposal=1)
print('saved', OUT)
