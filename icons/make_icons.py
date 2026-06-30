"""Generate Focus Lock PNG icons (16, 48, 128) with a simple padlock on a
gradient-style rounded background. Run once to (re)create the icons."""

from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Vertical gradient background (blue -> green), rounded corners.
    top = (108, 140, 255)
    bottom = (52, 211, 153)
    radius = max(2, size // 5)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bgd = ImageDraw.Draw(bg)
    for y in range(size):
        bgd.line([(0, y), (size, y)], fill=lerp(top, bottom, y / size) + (255,))
    # Mask for rounded corners.
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    img.paste(bg, (0, 0), mask)

    # Padlock dimensions.
    cx = size / 2
    body_w = size * 0.46
    body_h = size * 0.34
    body_left = cx - body_w / 2
    body_top = size * 0.46
    body_right = cx + body_w / 2
    body_bottom = body_top + body_h
    white = (255, 255, 255, 255)

    # Shackle (arc) drawn as a thick arc.
    shackle_w = body_w * 0.62
    shackle_top = size * 0.20
    shackle_left = cx - shackle_w / 2
    shackle_right = cx + shackle_w / 2
    lw = max(2, int(size * 0.07))
    draw.arc(
        [shackle_left, shackle_top, shackle_right, body_top + size * 0.04],
        start=180,
        end=360,
        fill=white,
        width=lw,
    )

    # Lock body.
    r = max(1, int(size * 0.05))
    draw.rounded_rectangle(
        [body_left, body_top, body_right, body_bottom], radius=r, fill=white
    )

    # Keyhole.
    kh_r = max(1, int(size * 0.045))
    draw.ellipse(
        [cx - kh_r, body_top + body_h * 0.28, cx + kh_r, body_top + body_h * 0.28 + 2 * kh_r],
        fill=(40, 50, 80, 255),
    )

    return img


for s in (16, 48, 128):
    make_icon(s).save(f"icon{s}.png")
    print(f"wrote icon{s}.png")
