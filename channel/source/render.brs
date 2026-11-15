' ============================================================================
' render.brs - camera and the layered reef renderer.
'
' Layers, back to front: water gradient, distant reef silhouettes (parallax), light shafts,
' cave interiors and back decor, rock and sand, reef flora, creatures and effects, foreground
' cover (seagrass fronts, cave mouth shadows), drifting particles, target rings, screen tints.
' Scenery is a display list per sector (data/scene_<region>.json, composed by tools/art from a
' small sprite kit); every piece is multiplied by a light colour that follows time of day and
' depth, so one kit gives day, dusk, night and three depths.
' ============================================================================

sub CameraInit()
    m.cam = {
        x: 12.0, y: 34.0        ' focus (world units)
        viewH: 10.0             ' world units visible vertically
        ppu: 72.0               ' pixels per world unit
        halfW: 8.9, halfH: 5.0
        sector: -1
        trans: false, fromX: 0.0, fromY: 0.0, tt: 0.0
        velX: 0.0, velY: 0.0
        shake: 0.0, shakeT: 0.0
        ox: 0, oy: 0            ' shake offset in pixels
        attractT: 0.0
        danger: 0.0
    }
end sub

' Keep the view inside a sector ("room"); the top row may show a little above the surface.
sub CameraClamp(x as float, y as float, sector as integer)
    cam = m.cam
    col = sector MOD 3
    row = sector \ 3
    x0 = col * 24.0
    y0 = (2 - row) * 13.5
    hw = cam.halfW
    hh = cam.halfH
    if hw * 2 >= 24 then
        fx = x0 + 12.0
    else
        fx = x0 + DxWrap(x0, x)
        if fx < x0 + hw then fx = x0 + hw
        if fx > x0 + 24 - hw then fx = x0 + 24 - hw
    end if
    top = y0 + 13.5
    if row = 0 then top = 41.7
    bottom = y0
    if row = 2 then bottom = y0 - 0.6
    if hh * 2 >= top - bottom then
        fy = (top + bottom) / 2
    else
        fy = y
        if fy < bottom + hh then fy = bottom + hh
        if fy > top - hh then fy = top - hh
    end if
    m.camWantX = WrapX(fx)
    m.camWantY = fy
end sub

sub CameraSnap(x as float, y as float, sector as integer, viewH as float)
    cam = m.cam
    cam.viewH = viewH
    cam.halfH = viewH / 2
    cam.halfW = viewH * 0.8888889
    cam.ppu = 720.0 / viewH
    CameraClamp(x, y, sector)
    cam.x = m.camWantX
    cam.y = m.camWantY
    cam.sector = sector
    cam.trans = false
    cam.velX = 0.0
    cam.velY = 0.0
end sub

function CameraDesiredViewH(w as object) as float
    p = w.player
    if p = invalid then return 11.5
    vh = 5.3 + p.vlen * 3.8
    if vh < 6.8 then vh = 6.8
    if vh > 13.4 then vh = 13.4
    vh = vh + m.cam.danger * 0.6
    if vh > 14.4 then vh = 14.4
    return vh
end function

sub CameraShake(amount as float)
    if not m.save.settings.shake then return
    if amount > m.cam.shake then m.cam.shake = amount
end sub

sub CameraUpdate(w as object, dt as float, alpha as float)
    cam = m.cam
    p = w.player
    free = false
    if p = invalid then
        cam.attractT = cam.attractT + dt
        tx = WrapX(36 + 30 * Sin(cam.attractT * 0.018))
        ty = 21 + 11 * Sin(cam.attractT * 0.031 + 1.3)
        sector = SectorOf(tx, ty)
        free = true
        want = 11.5
    else
        tx = WrapX(p.px + DxWrap(p.px, p.x) * alpha)
        ty = p.py + (p.y - p.py) * alpha
        sector = p.sector
        want = CameraDesiredViewH(w)
    end if
    ' zoom
    k = 1 - Exp(-dt * 2.2)
    cam.viewH = cam.viewH + (want - cam.viewH) * k
    cam.halfH = cam.viewH / 2
    cam.halfW = cam.viewH * 0.8888889
    cam.ppu = 720.0 / cam.viewH
    if free then
        m.camWantX = tx
        m.camWantY = ty
    else
        CameraClamp(tx, ty, sector)
    end if
    wx = m.camWantX
    wy = m.camWantY
    if sector <> cam.sector and cam.sector >= 0 and not free then
        cam.trans = true
        cam.fromX = cam.x
        cam.fromY = cam.y
        cam.tt = 0.0
    end if
    cam.sector = sector
    if cam.trans then
        cam.tt = cam.tt + dt
        kk = cam.tt / 0.38
        if kk > 1 then kk = 1.0
        if kk < 0.5 then
            e = 2 * kk * kk
        else
            e = 1 - ((-2 * kk + 2) ^ 2) / 2
        end if
        cam.x = WrapX(cam.fromX + DxWrap(cam.fromX, wx) * e)
        cam.y = cam.fromY + (wy - cam.fromY) * e
        if kk >= 1 then cam.trans = false
        cam.velX = 0.0
        cam.velY = 0.0
    else
        ' critically damped follow (stable for any dt)
        smooth = 0.32
        if free then smooth = 2.2
        omega = 2 / smooth
        xx = omega * dt
        ex = 1 / (1 + xx + 0.48 * xx * xx + 0.235 * xx * xx * xx)
        target = cam.x + DxWrap(cam.x, wx)
        change = cam.x - target
        temp = (cam.velX + omega * change) * dt
        cam.velX = (cam.velX - omega * temp) * ex
        cam.x = WrapX(target + (change + temp) * ex)
        change = cam.y - wy
        temp = (cam.velY + omega * change) * dt
        cam.velY = (cam.velY - omega * temp) * ex
        cam.y = wy + (change + temp) * ex
    end if
    if cam.shake > 0.001 then
        cam.shakeT = cam.shakeT + dt * 40
        cam.ox = Int(Sin(cam.shakeT * 1.3) * cam.shake * cam.ppu)
        cam.oy = Int(Cos(cam.shakeT * 1.7) * cam.shake * cam.ppu)
        cam.shake = cam.shake * MaxF(0.0, 1 - dt * 6)
    else
        cam.ox = 0
        cam.oy = 0
    end if
    w.focusX = cam.x
    w.focusY = cam.y
    w.halfW = cam.halfW
    w.halfH = cam.halfH
end sub

' ---------------------------------------------------------------- lighting
' Light at the surface for the time of day, as [r, g, b] in 0..1: night is dim and blue, dawn and
' dusk are warm. Two biomes are murkier than the rest.
function LightBase(dl as float, biome as string) as object
    r = 0.3 + 0.7 * dl
    g = 0.42 + 0.58 * dl
    b = 0.7 + 0.3 * dl
    warm = 4 * dl * (1 - dl)
    g = g * (1 - 0.1 * warm)
    b = b * (1 - 0.24 * warm)
    if biome = "twilightWreck" then
        r = r * 0.8
        g = g * 0.86
    else if biome = "deepCanyon" then
        r = r * 0.84
        g = g * 0.82
    end if
    return [r, g, b]
end function

' Light colour at a depth (row 0 = the sunlit top row .. 2 = the seabed row; fractions allowed).
' Deeper water loses red first.
function LightFor(dl as float, row as float, biome as string) as object
    l = LightBase(dl, biome)
    d = row * 0.5
    l[0] = l[0] * (1 - 0.3 * d)
    l[1] = l[1] * (1 - 0.17 * d)
    l[2] = l[2] * (1 - 0.03 * d)
    return l
end function

function LightColor(l as object, a = 255 as integer) as integer
    return Rgba(Int(l[0] * 255), Int(l[1] * 255), Int(l[2] * 255), a)
end function

' ---------------------------------------------------------------- scene display lists
' scene_<region>.json (composed by tools/art/scene.mjs):
'   { names: [sprite ids], tints: { biome: [[r,g,b,a], ...] },
'     sectors: [ { biome, back: [...], rock: [...], flora: [...], front: [...] } x 9 ] }
' Each placement: [nameIndex, x, y, scaleX, scaleY, rotationDeg, tintIndex, swayAmp, swayRate, flags]
'   x, y   world units of the sprite's pivot (y up)
'   scale  1 = the sprite's authored size (its "len" pixels = one world unit)
'   flags  1 = mirror horizontally
' Every piece is lit by its own depth, so a pillar that climbs from the seabed to the shallows
' shades smoothly from deep blue to sunlit.
function SceneLoad(regionId as string) as dynamic
    j = ReadJson("pkg:/data/scene_" + regionId + ".json")
    if j = invalid then return invalid
    scene = { id: regionId, sectors: [] }
    names = j.names
    canFlip = m.caps.flip
    for each sj in j.sectors
        sec = { biome: sj.biome, layers: [], n: 0, lightKey: -1 }
        tints = j.tints[LCase(sj.biome)]
        li = 0
        for each lname in ["back", "rock", "flora", "front"]
            src = sj[lname]
            lst = []
            if src <> invalid then
                for each a in src
                    spr = m.spr[names[a[0]]]
                    if spr <> invalid then
                        p = spr.parts[0]
                        tc = [255, 255, 255, 255]
                        if a[6] >= 0 and tints <> invalid then
                            if a[6] < tints.Count() then tc = tints[a[6]]
                        end if
                        ' depth shading; living things keep more of their colour in deep water
                        d = ((40.5 - a[2]) / 13.5 - 0.5) * 0.5
                        if d < 0 then d = 0.0
                        if d > 1.15 then d = 1.15
                        if li >= 2 then d = d * 0.55
                        k = 1.0 / spr.len
                        bx = spr.box
                        mx = MaxF(Abs(bx[0]), Abs(bx[2]))
                        my = MaxF(Abs(bx[1]), Abs(bx[3]))
                        it = {
                            r0: p.r0, r1: p.r1, r2: p.r2
                            x: a[1], y: a[2]
                            sx: a[3] * k, sy: a[4] * k
                            rot: a[5]
                            tr: tc[0] * (1 - 0.3 * d), tg: tc[1] * (1 - 0.17 * d), tb: tc[2] * (1 - 0.03 * d), ta: tc[3]
                            col: -1
                            sway: a[7], rate: a[8]
                            ph: (a[1] * 1.7 + a[2] * 2.3)
                            ' radius in world units for culling
                            ext: Sqr(mx * mx + my * my) * MaxF(a[3], a[4]) * k + 0.1
                        }
                        if a[9] = 1 and canFlip then it.sx = -it.sx
                        ' sprites built from several parts (seagrass, soft corals) carry a sway rig
                        if spr.n > 1 or p.ax <> 0 or p.ay <> 0 then
                            it.spr = spr
                            rad = a[5] * 0.0174533
                            it.cs = Cos(rad)
                            it.sn = Sin(rad)
                        end if
                        lst.Push(it)
                    end if
                end for
            end if
            sec.layers.Push(lst)
            sec.n = sec.n + lst.Count()
            li = li + 1
        end for
        scene.sectors.Push(sec)
    end for
    return scene
end function

' Recolour a sector's pieces for the time of day (only when the light changed noticeably).
sub SceneRelight(sec as object, dl as float)
    key = Int(dl * 40)
    if sec.lightKey = key then return
    sec.lightKey = key
    l = LightBase(dl, sec.biome)
    lr = l[0]
    lg = l[1]
    lb = l[2]
    for each lst in sec.layers
        for each it in lst
            r = Int(it.tr * lr)
            g = Int(it.tg * lg)
            b = Int(it.tb * lb)
            if r > 255 then r = 255
            if g > 255 then g = 255
            if b > 255 then b = 255
            if r >= 128 then r = r - 256
            it.col = r * 16777216 + g * 65536 + b * 256 + it.ta
        end for
    end for
end sub

' Draw one layer of one sector.
sub SceneDrawLayer(lst as object, camX as float, camY as float, ppu as float, cx as integer, cy as integer, hw as float, hh as float, t as float, canRot as boolean)
    scr = m.screen
    for each it in lst
        dx = it.x - camX
        if dx > 36 then
            dx = dx - 72
        else if dx < -36 then
            dx = dx + 72
        end if
        ext = it.ext
        if dx < hw + ext and dx > -hw - ext then
            dy = it.y - camY
            if dy < hh + ext and dy > -hh - ext then
                k = it.sx * ppu
                ky = it.sy * ppu
                if it.spr <> invalid then
                    SceneDrawRig(it, cx + Int(dx * ppu), cy - Int(dy * ppu), k, ky, t)
                else
                    if ky < 0.3 then
                        reg = it.r2
                        k = k * 4
                        ky = ky * 4
                    else if ky < 0.6 then
                        reg = it.r1
                        k = k * 2
                        ky = ky * 2
                    else
                        reg = it.r0
                    end if
                    rot = it.rot
                    if it.sway <> 0 then rot = rot + it.sway * Sin(t * it.rate + it.ph)
                    if rot <> 0 and canRot then
                        scr.DrawTransformedObject(cx + Int(dx * ppu), cy - Int(dy * ppu), rot, k, ky, reg, it.col)
                    else
                        scr.DrawScaledObject(cx + Int(dx * ppu), cy - Int(dy * ppu), k, ky, reg, it.col)
                    end if
                end if
            end if
        end if
    end for
end sub

' A kit sprite made of several parts, each swaying about its own base.
sub SceneDrawRig(it as object, sx as integer, sy as integer, k as float, ky as float, t as float)
    scr = m.screen
    spr = it.spr
    canRot = m.caps.rotate
    mip = 0
    f = 1.0
    if ky < 0.3 then
        mip = 2
        f = 4.0
    else if ky < 0.6 then
        mip = 1
        f = 2.0
    end if
    col = it.col
    ph = it.ph
    base = it.rot
    cs = it.cs
    sn = it.sn
    flip = 1.0
    if k < 0 then flip = -1.0
    for each p in spr.parts
        if mip = 2 then
            reg = p.r2
        else if mip = 1 then
            reg = p.r1
        else
            reg = p.r0
        end if
        ox = p.ax * k
        oy = p.ay * ky
        if base <> 0 and canRot then
            x = sx + Int(ox * cs + oy * sn)
            y = sy + Int(oy * cs - ox * sn)
        else
            x = sx + Int(ox)
            y = sy + Int(oy)
        end if
        rot = base
        if p.k = 4 then rot = rot + p.a * Sin(t * p.b * 6.2831853 + p.c + ph) * flip
        if rot <> 0 and canRot then
            scr.DrawTransformedObject(x, y, rot, k * f, ky * f, reg, col)
        else
            scr.DrawScaledObject(x, y, k * f, ky * f, reg, col)
        end if
    end for
end sub

' ---------------------------------------------------------------- creatures
' Draw one creature with its rig. sx, sy: screen position of its origin; ppu: pixels per unit.
sub DrawCreature(c as object, sx as integer, sy as integer, ppu as float, col as integer, t as float)
    spr = c.spr
    if spr = invalid then
        spr = m.spr[c.sp.sprite]
        if spr = invalid then spr = m.spr["_missing"]
        c.spr = spr
        if spr = invalid then return
    end if
    scr = m.screen
    k = c.vlen * ppu / spr.len
    if c.inflated then k = k * 1.35
    face = c.face
    af = face
    if af < 0 then af = -af
    if af < 0.1 then return
    f = 1.0
    mip = 0
    if k < 0.3 then
        mip = 2
        f = 4.0
    else if k < 0.6 then
        mip = 1
        f = 2.0
    end if
    canRot = m.caps.rotate
    parts = spr.parts
    ' tiny on screen: draw the parts rigidly (no per-part animation maths)
    simple = (c.vlen * ppu < 30)
    if spr.base = 1 then
        ' seabed organisms: upright, anchored at the ground contact point
        kx = k * face
        ph = c.seed * 0.7
        for each p in parts
            if mip = 2 then
                reg = p.r2
            else if mip = 1 then
                reg = p.r1
            else
                reg = p.r0
            end if
            x = sx + Int(p.ax * kx)
            y = sy + Int(p.ay * k)
            pk = p.k
            if pk = 0 or simple or not canRot then
                scr.DrawScaledObject(x, y, kx * f, k * f, reg, col)
            else if pk = 4 or pk = 3 then
                rot = p.a * Sin(t * p.b * 6.2831853 + p.c + ph)
                if face < 0 then rot = -rot
                scr.DrawTransformedObject(x, y, rot, kx * f, k * f, reg, col)
            else if pk = 5 then
                s = p.a * Sin(t * p.b * 6.2831853 + p.c + ph)
                scr.DrawScaledObject(x, y, kx * f * (1 + s), k * f * (1 - s), reg, col)
            else if pk = 6 then
                scr.DrawScaledObject(x, y + Int(p.a * k * Sin(t * p.b * 6.2831853 + p.c + ph)), kx * f, k * f, reg, col)
            else
                scr.DrawScaledObject(x, y, kx * f, k * f, reg, col)
            end if
        end for
        return
    end if

    ' swimmers: pitch with the heading, mirror when facing left, animate the rig
    pitch = c.pitch
    if face < 0 then pitch = -pitch
    if not canRot then pitch = 0.0
    rad = pitch * 0.0174533
    cs = Cos(rad)
    sn = Sin(rad)
    kx = k * face
    ph = c.phase
    amp = 0.35 + 0.65 * c.speedNorm
    if amp > 1.15 then amp = 1.15
    fsign = 1.0
    if face < 0 then fsign = -1.0
    for each p in parts
        if mip = 2 then
            reg = p.r2
        else if mip = 1 then
            reg = p.r1
        else
            reg = p.r0
        end if
        ox = p.ax * kx
        oy = p.ay * k
        pk = p.k
        rot = pitch
        px = kx * f
        py = k * f
        if not simple then
            if pk = 1 then
                ' tail: swings and narrows with the swim cycle, follows the body wave
                rot = rot + p.a * amp * Sin(ph) * fsign
                px = px * (1 - p.b * amp * (0.5 - 0.5 * Cos(ph * 2)))
                if p.c <> 0 then oy = oy + p.c * k * amp * Sin(ph - p.d)
            else if pk = 2 then
                oy = oy + p.a * k * amp * Sin(ph - p.b)
            else if pk = 3 then
                rot = rot + p.a * Sin(t * p.b * 6.2831853 + p.c + ph * 0.3) * fsign
            else if pk = 4 then
                rot = rot + p.a * Sin(t * p.b * 6.2831853 + p.c + c.seed) * fsign
            else if pk = 5 then
                s = p.a * Sin(t * p.b * 6.2831853 + p.c + c.seed)
                px = px * (1 + s)
                py = py * (1 - s)
            else if pk = 6 then
                oy = oy + p.a * k * Sin(t * p.b * 6.2831853 + p.c + c.seed)
            end if
        end if
        x = sx + Int(ox * cs + oy * sn)
        y = sy + Int(oy * cs - ox * sn)
        if rot <> 0 and canRot then
            scr.DrawTransformedObject(x, y, rot, px, py, reg, col)
        else
            scr.DrawScaledObject(x, y, px, py, reg, col)
        end if
    end for
end sub

' Advance the per-creature drawing state (facing, pitch, swim phase). Called once per frame.
sub CreatureAnimate(c as object, dt as float)
    ch = c.hx
    if ch > 0.18 then
        c.faceTo = 1.0
    else if ch < -0.18 then
        c.faceTo = -1.0
    end if
    f = c.face
    ft = c.faceTo
    if f <> ft then
        ' ease through zero: reads as the fish turning around
        stepF = dt * 9
        if f < ft then
            f = f + stepF
            if f > ft then f = ft
        else
            f = f - stepF
            if f < ft then f = ft
        end if
        c.face = f
    end if
    if c.sp.mobile then
        ' pitch = atan(hy / |hx|), by a polynomial (no trig calls per creature per frame)
        ach = ch
        if ach < 0 then ach = -ach
        z = c.hy / (ach + 0.05)
        if z > 1.43 then
            want = 55.0
        else if z < -1.43 then
            want = -55.0
        else
            az = z
            if az < 0 then az = -az
            if az <= 1 then
                want = z * (0.9724 - 0.1919 * z * z) * 57.29578
            else
                want = (1.5708 - (1 / az) * (0.9724 - 0.1919 / (az * az))) * 57.29578
                if z < 0 then want = -want
            end if
        end if
        if c.sp.mv = 1 then want = want * 0.3
        c.pitch = c.pitch + (want - c.pitch) * MinF(1.0, dt * 7)
        sn = c.speedNorm
        if sn > 1.7 then sn = 1.7
        c.phase = c.phase + dt * 6.2831853 * (0.8 + 2.3 * sn)
        if c.phase > 628 then c.phase = c.phase - 628.3185
    end if
end sub
