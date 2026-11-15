' ============================================================================
' gfx.brs - screen, fonts, text and the sprite atlas loader.
'
' Everything is drawn with the Roku 2D API (roScreen, double buffered, 1280x720).
' Sprites come from WebP atlases plus sprites.json (built by tools/art). At load time each atlas
' also gets half and quarter size copies, so a sprite drawn much smaller than it was authored is
' taken from a copy close to its on-screen size (clean down-scaling without shimmer).
' ============================================================================

sub GfxInit()
    m.screen = CreateObject("roScreen", true, 1280, 720)
    m.port = CreateObject("roMessagePort")
    m.screen.SetMessagePort(m.port)
    m.screen.SetAlphaEnable(true)
    m.clock = CreateObject("roTimespan")
    m.clock.Mark()
    fr = CreateObject("roFontRegistry")
    m.fontReg = fr
    m.fonts = {
        tiny: fr.GetDefaultFont(17, false, false)
        small: fr.GetDefaultFont(20, false, false)
        smallb: fr.GetDefaultFont(20, true, false)
        body: fr.GetDefaultFont(24, false, false)
        bodyb: fr.GetDefaultFont(24, true, false)
        head: fr.GetDefaultFont(30, true, false)
        big: fr.GetDefaultFont(42, true, false)
        huge: fr.GetDefaultFont(64, true, false)
    }
    m.fontH = {}
    for each k in m.fonts
        m.fontH[k] = m.fonts[k].GetOneLineHeight()
    end for
    m.textW = {}
    m.textWCount = 0
    m.wrapCache = {}
    m.wrapCount = 0
    m.atlas = invalid
    m.spr = {}
    m.caps = { flip: true, rotate: true, tint: true }
end sub

' ---------------------------------------------------------------- capability probe
' The documentation only promises positive scales and right-angle rotations. Every current device
' is OpenGL and handles mirroring, free rotation and colour modulation, but rather than assume it
' the channel draws a test pattern off-screen and reads the pixels back. If a feature is missing
' the renderer falls back (pre-mirrored sprites, no body pitch, overlay darkening).
sub GfxProbe()
    caps = { flip: false, rotate: false, tint: false }
    src = CreateObject("roBitmap", { width: 16, height: 16, AlphaEnable: true })
    dst = CreateObject("roBitmap", { width: 32, height: 32, AlphaEnable: true })
    if src = invalid or dst = invalid then
        m.caps = caps
        return
    end if
    src.Clear(&h000000FF)
    src.DrawRect(0, 0, 8, 16, &hFFFFFFFF)       ' left half white, right half black
    src.Finish()
    reg = CreateObject("roRegion", src, 0, 0, 16, 16)
    reg.SetPretranslation(-8, -8)
    ' mirror
    dst.Clear(&h000000FF)
    dst.DrawScaledObject(16, 16, -1.0, 1.0, reg)
    dst.Finish()
    ba = dst.GetByteArray(10, 16, 1, 1)         ' left of centre: black when mirrored
    bb = dst.GetByteArray(20, 16, 1, 1)         ' right of centre: white when mirrored
    if ba <> invalid and bb <> invalid then
        if ba.Count() >= 3 and bb.Count() >= 3 then
            if ba[0] < 80 and bb[0] > 170 then caps.flip = true
        end if
    end if
    ' free rotation: after 45 degrees the corner pixel of the bounding box is uncovered
    dst.Clear(&h000000FF)
    src.Clear(&hFFFFFFFF)
    src.Finish()
    dst.DrawRotatedObject(16, 16, 45.0, reg)
    dst.Finish()
    ba = dst.GetByteArray(16, 6, 1, 1)          ' above the square: covered only when rotated
    bb = dst.GetByteArray(9, 9, 1, 1)           ' old corner: empty when rotated
    if ba <> invalid and bb <> invalid then
        if ba.Count() >= 3 and bb.Count() >= 3 then
            if ba[0] > 170 and bb[0] < 80 then caps.rotate = true
        end if
    end if
    ' colour modulation
    dst.Clear(&h000000FF)
    dst.DrawObject(16, 16, reg, &hFF0000FF)
    dst.Finish()
    ba = dst.GetByteArray(16, 16, 1, 1)
    if ba <> invalid then
        if ba.Count() >= 3 then
            if ba[0] > 170 and ba[1] < 80 then caps.tint = true
        end if
    end if
    m.caps = caps
    print "gfx caps: flip="; caps.flip; " rotate="; caps.rotate; " tint="; caps.tint
end sub

' ---------------------------------------------------------------- text
function TextWidth(text as string, fontKey as string) as integer
    key = fontKey + "|" + text
    w = m.textW[key]
    if w <> invalid then return w
    w = m.fonts[fontKey].GetOneLineWidth(text, 4000)
    if m.textWCount > 900 then
        m.textW = {}
        m.textWCount = 0
    end if
    m.textW[key] = w
    m.textWCount = m.textWCount + 1
    return w
end function

sub DrawTextL(text as string, x as integer, y as integer, color as integer, fontKey as string)
    m.screen.DrawText(text, x, y, color, m.fonts[fontKey])
end sub

sub DrawTextC(text as string, cx as integer, y as integer, color as integer, fontKey as string)
    m.screen.DrawText(text, cx - TextWidth(text, fontKey) \ 2, y, color, m.fonts[fontKey])
end sub

sub DrawTextR(text as string, rx as integer, y as integer, color as integer, fontKey as string)
    m.screen.DrawText(text, rx - TextWidth(text, fontKey), y, color, m.fonts[fontKey])
end sub

' Text with a soft dark offset copy underneath, for legibility over the reef.
sub DrawTextShadow(text as string, x as integer, y as integer, color as integer, fontKey as string)
    f = m.fonts[fontKey]
    m.screen.DrawText(text, x + 1, y + 2, &h00101CB0, f)
    m.screen.DrawText(text, x, y, color, f)
end sub

sub DrawTextShadowC(text as string, cx as integer, y as integer, color as integer, fontKey as string)
    DrawTextShadow(text, cx - TextWidth(text, fontKey) \ 2, y, color, fontKey)
end sub

' Word-wrap to a pixel width. Results are cached because menus redraw the same text every frame.
function WrapText(text as string, fontKey as string, maxW as integer) as object
    key = fontKey + "|" + maxW.ToStr() + "|" + text
    hit = m.wrapCache[key]
    if hit <> invalid then return hit
    lines = []
    paras = text.Split(Chr(10))
    for each para in paras
        words = para.Split(" ")
        cur = ""
        for each word in words
            if cur = "" then
                trial = word
            else
                trial = cur + " " + word
            end if
            if TextWidth(trial, fontKey) <= maxW or cur = "" then
                cur = trial
            else
                lines.Push(cur)
                cur = word
            end if
        end for
        lines.Push(cur)
    end for
    if m.wrapCount > 300 then
        m.wrapCache = {}
        m.wrapCount = 0
    end if
    m.wrapCache[key] = lines
    m.wrapCount = m.wrapCount + 1
    return lines
end function

' Draws wrapped text; returns the y just below the last line.
function DrawWrapped(text as string, x as integer, y as integer, maxW as integer, color as integer, fontKey as string, maxLines = 99 as integer) as integer
    lines = WrapText(text, fontKey, maxW)
    lh = m.fontH[fontKey]
    f = m.fonts[fontKey]
    n = 0
    for each ln in lines
        if n >= maxLines then exit for
        m.screen.DrawText(ln, x, y, color, f)
        y = y + lh
        n = n + 1
    end for
    return y
end function

function WrappedHeight(text as string, maxW as integer, fontKey as string) as integer
    return WrapText(text, fontKey, maxW).Count() * m.fontH[fontKey]
end function

' Shorten text with an ellipsis so it fits a width.
function FitText(text as string, fontKey as string, maxW as integer) as string
    if TextWidth(text, fontKey) <= maxW then return text
    s = text
    while Len(s) > 1 and TextWidth(s + "...", fontKey) > maxW
        s = Left(s, Len(s) - 1)
    end while
    return s + "..."
end function

' ---------------------------------------------------------------- atlases and sprites
' sprites.json: { atlases: [{file,w,h,group}], sprites: { id: { len, base, tint, box, parts: [[atlas,x,y,w,h,pivx,pivy,atx,aty,kind,p1,p2,p3,p4], ...] } } }
'
' After loading, m.spr[id] is:
'   { len, base, box, n, parts: [ { r0, r1, r2, ax, ay, k, a, b, c, d, w, h }, ... ], whole: {r0,r1,r2} }
' r0/r1/r2 are roRegions on the full, half and quarter size atlas with the pivot as their origin.

function GfxLoadAtlasMeta() as boolean
    j = ReadJson("pkg:/assets/sprites.json")
    if j = invalid then return false
    m.atlasMeta = j
    m.atlasBmp = []
    m.atlasNext = 0
    return true
end function

' Loads one atlas per call so the loading bar can move. Returns true when all are loaded.
function GfxLoadNextAtlas() as boolean
    meta = m.atlasMeta
    i = m.atlasNext
    if i >= meta.atlases.Count() then return true
    a = meta.atlases[i]
    bmp = CreateObject("roBitmap", "pkg:/assets/" + a.file)
    if bmp = invalid then
        print "GfxLoadNextAtlas: cannot load "; a.file
        m.atlasBmp.Push(invalid)
    else
        entry = { b0: bmp, b1: invalid, b2: invalid }
        ' Creature and kit sheets get smaller copies; the UI sheet is always drawn 1:1.
        if a.group <> "ui" then
            entry.b1 = GfxHalf(bmp)
            if entry.b1 <> invalid then entry.b2 = GfxHalf(entry.b1)
        end if
        m.atlasBmp.Push(entry)
    end if
    m.atlasNext = i + 1
    return m.atlasNext >= meta.atlases.Count()
end function

' Half-size copy of a bitmap. Alpha blending is switched off on the destination so the pixels
' (including their alpha) are copied rather than blended onto transparent black.
function GfxHalf(src as object) as object
    w = src.GetWidth() \ 2
    h = src.GetHeight() \ 2
    if w < 1 or h < 1 then return invalid
    dst = CreateObject("roBitmap", { width: w, height: h, AlphaEnable: false })
    if dst = invalid then return invalid
    dst.SetAlphaEnable(false)
    reg = CreateObject("roRegion", src, 0, 0, w * 2, h * 2)
    reg.SetScaleMode(1)
    dst.DrawScaledObject(0, 0, 0.5, 0.5, reg)
    dst.Finish()
    return dst
end function

function GfxMakeRegion(bmp as object, x as integer, y as integer, w as integer, h as integer, px as integer, py as integer) as object
    if bmp = invalid then return invalid
    if w < 1 then w = 1
    if h < 1 then h = 1
    bw = bmp.GetWidth()
    bh = bmp.GetHeight()
    if x + w > bw then w = bw - x
    if y + h > bh then h = bh - y
    if w < 1 or h < 1 then return invalid
    r = CreateObject("roRegion", bmp, x, y, w, h)
    if r = invalid then return invalid
    r.SetPretranslation(-px, -py)
    r.SetScaleMode(1)
    return r
end function

' Builds the region objects for every sprite. Call after all atlases are loaded.
sub GfxBuildSprites()
    meta = m.atlasMeta
    spr = {}
    for each id in meta.sprites
        s = meta.sprites[id]
        parts = []
        for each p in s.parts
            e = m.atlasBmp[p[0]]
            if e <> invalid then
                x = p[1] : y = p[2] : w = p[3] : h = p[4] : px = p[5] : py = p[6]
                part = {
                    r0: GfxMakeRegion(e.b0, x, y, w, h, px, py)
                    r1: invalid
                    r2: invalid
                    ax: p[7], ay: p[8], k: p[9], a: p[10], b: p[11], c: p[12], d: p[13]
                    w: w, h: h, px: px, py: py
                }
                if e.b1 <> invalid then part.r1 = GfxMakeRegion(e.b1, x \ 2, y \ 2, (w + 1) \ 2, (h + 1) \ 2, px \ 2, py \ 2)
                if e.b2 <> invalid then part.r2 = GfxMakeRegion(e.b2, x \ 4, y \ 4, (w + 3) \ 4, (h + 3) \ 4, px \ 4, py \ 4)
                if part.r1 = invalid then part.r1 = part.r0
                if part.r2 = invalid then part.r2 = part.r1
                if part.r0 <> invalid then parts.Push(part)
            end if
        end for
        o = { len: s.len, base: s.base, box: s.box, parts: parts, n: parts.Count(), tint: false }
        if s.tint <> invalid then o.tint = true
        if s.x <> invalid then o.x = s.x
        spr[id] = o
    end for
    m.spr = spr
    ' Without mirror support, keep mirrored copies of the creature sheets (built on first use).
    m.flipCache = {}
end sub

function SprGet(id as string) as dynamic
    return m.spr[LCase(id)]
end function

' Draw a single-part sprite (UI pieces, kit pieces) with its pivot at x,y.
sub DrawSpr(id as string, x as integer, y as integer, scale = 1.0 as float, color = -1 as integer)
    s = m.spr[id]
    if s = invalid then return
    p = s.parts[0]
    if scale = 1.0 then
        m.screen.DrawObject(x, y, p.r0, color)
    else
        m.screen.DrawScaledObject(x, y, scale, scale, p.r0, color)
    end if
end sub

sub DrawSprXY(id as string, x as integer, y as integer, sx as float, sy as float, color = -1 as integer)
    s = m.spr[id]
    if s = invalid then return
    m.screen.DrawScaledObject(x, y, sx, sy, s.parts[0].r0, color)
end sub

' A whole multi-part sprite in its neutral pose (portraits, menus). scale is relative to authored size.
sub DrawSprWhole(id as string, x as integer, y as integer, scale as float, color = -1 as integer, flip = false as boolean)
    s = m.spr[LCase(id)]
    if s = invalid then return
    scr = m.screen
    fx = scale
    if flip then fx = -scale
    for each p in s.parts
        r = p.r0
        k = scale
        if scale < 0.3 then
            r = p.r2
            k = scale * 4
        else if scale < 0.6 then
            r = p.r1
            k = scale * 2
        end if
        kx = k
        if flip then kx = -k
        scr.DrawScaledObject(x + Int(p.ax * fx), y + Int(p.ay * scale), kx, k, r, color)
    end for
end sub

' ---------------------------------------------------------------- simple shapes
sub FillRect(x as integer, y as integer, w as integer, h as integer, color as integer)
    m.screen.DrawRect(x, y, w, h, color)
end sub

sub FrameRect(x as integer, y as integer, w as integer, h as integer, t as integer, color as integer)
    scr = m.screen
    scr.DrawRect(x, y, w, t, color)
    scr.DrawRect(x, y + h - t, w, t, color)
    scr.DrawRect(x, y + t, t, h - 2 * t, color)
    scr.DrawRect(x + w - t, y + t, t, h - 2 * t, color)
end sub

' Rounded translucent panel drawn from rectangles (no texture needed): a body, bevelled corners
' and a thin lighter edge on top, which reads as frosted glass over the reef.
sub Panel(x as integer, y as integer, w as integer, h as integer, fill = &h061A2CC8 as integer, edge = &h9FE8FF30 as integer)
    scr = m.screen
    scr.DrawRect(x + 6, y, w - 12, h, fill)
    scr.DrawRect(x + 2, y + 2, 4, h - 4, fill)
    scr.DrawRect(x + w - 6, y + 2, 4, h - 4, fill)
    scr.DrawRect(x, y + 6, 2, h - 12, fill)
    scr.DrawRect(x + w - 2, y + 6, 2, h - 12, fill)
    if edge <> 0 then
        scr.DrawRect(x + 6, y, w - 12, 1, edge)
        scr.DrawRect(x + 6, y + h - 1, w - 12, 1, (edge and &hFFFFFF00) + ((edge and &hFF) \ 2))
    end if
end sub

' Horizontal meter with a rounded look.
sub Meter(x as integer, y as integer, w as integer, h as integer, frac as float, color as integer, back = &h00000070 as integer)
    scr = m.screen
    scr.DrawRect(x + 2, y, w - 4, h, back)
    scr.DrawRect(x, y + 2, 2, h - 4, back)
    scr.DrawRect(x + w - 2, y + 2, 2, h - 4, back)
    if frac < 0 then frac = 0
    if frac > 1 then frac = 1
    fw = Int((w - 4) * frac)
    if fw > 0 then
        scr.DrawRect(x + 2, y + 2, fw, h - 4, color)
        ' highlight strip
        scr.DrawRect(x + 2, y + 2, fw, (h - 4) \ 3, &hFFFFFF38)
    end if
end sub
