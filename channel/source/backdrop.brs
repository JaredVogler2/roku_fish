' ============================================================================
' backdrop.brs - what lies behind the play plane: distant reef silhouettes with parallax, light
' shafts from the surface and the surface shimmer itself. All of it is a handful of tinted sprites.
' ============================================================================

sub RenderBackdrop(w as object, rr as object, biome as string, sector as integer, t as float, dl as float, light as object)
    scr = m.screen
    cam = m.cam
    ppu = cam.ppu
    canTint = m.caps.tint
    row = sector \ 3

    ' ---- the surface: sky above the waterline, a rippled bright edge, glow spilling down by day
    glow = m.spr["fx_glow"]
    topY = 360 + cam.oy - Int((40.5 - cam.y) * ppu)          ' screen y of the water surface
    if glow <> invalid and topY > -500 then
        a = Int(dl * 95)
        if a > 4 then scr.DrawScaledObject(640, topY - 40, 16.0, 5.0, glow.parts[0].r0, &hE6FFF200 + a)
    end if
    if topY > 0 then
        ' sky: night navy to day blue, warm at dawn and dusk
        warm = 4 * dl * (1 - dl)
        sr = Int(14 + 150 * dl + 90 * warm)
        sg = Int(24 + 188 * dl + 20 * warm)
        sb = Int(52 + 190 * dl - 40 * warm)
        if sr > 255 then sr = 255
        scr.DrawRect(0, 0, 1280, topY, Rgba(sr, sg, sb, 255))
        ' paler toward the horizon (the waterline)
        grad = m.spr["fx_grad"]
        if grad <> invalid then
            g = grad.parts[0]
            scr.DrawScaledObject(0, 0, 1280.0 / g.w, topY / g.h, g.r0, Rgba(255, 250, 235, Int(40 + 110 * dl)))
        end if
        srf = m.spr["fx_surface"]
        if srf <> invalid then
            p = srf.parts[0]
            k = ppu / 96.0
            if k < 0.6 then k = 0.6
            span = p.w * k
            ox = -((cam.x * ppu + t * 14) MOD span)
            a = Int(120 + 120 * dl)
            ' whole-pixel tile width, so neighbours meet exactly (an overlap would show as a bright seam)
            tw = Int(span)
            k = tw / p.w
            x = Int(ox) - tw
            while x < 1280
                scr.DrawScaledObject(x, topY, k, k, p.r0, &hF4FFFF00 + a)
                x = x + tw
            end while
        end if
    end if

    ' ---- distant reef: two silhouette bands that scroll slower than the play plane
    b = invalid
    if m.biomes <> invalid then b = m.biomes[LCase(biome)]
    if b <> invalid then
        wall = b.backwall
        if wall > 0 then
            far = m.spr["bg_ridge_far"]
            near = m.spr["bg_ridge_near"]
            haze = b.haze
            lr = light[0]
            lg = light[1]
            lb = light[2]
            ' the bands sit just below the camera row so every depth has something behind it
            baseY = (2 - row) * 13.5
            if far <> invalid then
                p = far.parts[0]
                k = ppu / far.len * 1.15
                par = 0.35
                yy = 360 - Int((baseY + 5.2 * wall - cam.y) * ppu * (0.55 + 0.45 * par))
                span = p.w * k
                ox = -((cam.x * ppu * par) MOD span)
                hr = haze[0] * lr * 0.86
                hg = haze[1] * lg * 0.9
                hb = haze[2] * lb
                col = Rgba(Int(hr), Int(hg), Int(hb), 255)
                if not canTint then col = -1
                x = ox - span
                while x < 1280
                    scr.DrawScaledObject(Int(x), yy, k, k, p.r0, col)
                    x = x + span - 1
                end while
                ' continue the band downward (the bottom row of the sprite is 66.5 % of its tint)
                scr.DrawRect(0, yy + Int(p.h * k * 0.5) - 1, 1280, 720, Rgba(Int(hr * 0.665), Int(hg * 0.665), Int(hb * 0.665), 255))
            end if
            if near <> invalid then
                p = near.parts[0]
                k = ppu / near.len * 1.25
                par = 0.6
                yy = 360 - Int((baseY + 2.4 * wall - cam.y) * ppu * (0.55 + 0.45 * par))
                span = p.w * k
                ox = -((cam.x * ppu * par + 300) MOD span)
                hr = haze[0] * lr * 0.62
                hg = haze[1] * lg * 0.7
                hb = haze[2] * lb * 0.86
                col = Rgba(Int(hr), Int(hg), Int(hb), 255)
                if not canTint then col = -1
                x = ox - span
                while x < 1280
                    scr.DrawScaledObject(Int(x), yy, k, k, p.r0, col)
                    x = x + span - 1
                end while
                scr.DrawRect(0, yy + Int(p.h * k * 0.5) - 1, 1280, 720, Rgba(Int(hr * 0.665), Int(hg * 0.665), Int(hb * 0.665), 255))
            end if
        end if
    end if

    ' ---- light shafts: slow, soft, strongest near the surface in daylight
    shaft = m.spr["fx_shaft"]
    if shaft <> invalid then
        depth = 1 - cam.y / 40.5
        strength = (0.25 + 0.75 * dl) * (1 - depth * 0.75)
        if biome = "twilightWreck" then strength = strength * 0.6
        if strength > 0.06 then
            p = shaft.parts[0]
            ky = 760.0 / p.h
            for i = 0 to 4
                ph = i * 1.7
                x = (i * 290 + 120 + Int(Sin(t * 0.11 + ph) * 60) - Int(cam.x * ppu * 0.18)) MOD 1500
                if x < 0 then x = x + 1500
                a = Int((0.55 + 0.45 * Sin(t * 0.37 + ph * 2.1)) * strength * 120)
                if a > 3 then
                    kx = (1.0 + 0.5 * Sin(ph * 3.3)) * 1.3
                    c0 = &hDDF8FF00
                    if dl < 0.35 then c0 = &hA8C4FF00
                    sy0 = -30
                    if topY > sy0 then sy0 = topY
                    scr.DrawScaledObject(x - 150, sy0, kx, ky, p.r0, c0 + a)
                end if
            end for
        end if
    end if
end sub
