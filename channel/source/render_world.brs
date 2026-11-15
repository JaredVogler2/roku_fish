' ============================================================================
' render_world.brs - draws one frame of the reef (everything under the HUD).
' ============================================================================

sub RenderInit()
    m.rw = {
        t: 0.0
        scenes: {}
        scene: invalid
        motes: []
        bubbles: []
        back: []
        swim: []
        lightKey: ""
        light: [1.0, 1.0, 1.0]
        lightCol: -1
        biome: "sunlitGardens"
        prevBiome: "sunlitGardens"
        biomeMix: 1.0
        dmgFlash: 0.0
    }
    r = RngNew(4242)
    for i = 0 to 33
        m.rw.motes.Push({ x: RngRange(r, 0, 1280), y: RngRange(r, 0, 720), vx: RngRange(r, -9, 9), vy: RngRange(r, -7, 4), s: RngRange(r, 0.25, 0.9), a: RngInt(r, 30, 110), ph: RngRange(r, 0, 6.28) })
    end for
    m.biomes = ReadJson("pkg:/data/biomes.json")
end sub

sub RenderSetRegion(regionId as string)
    rw = m.rw
    sc = rw.scenes[regionId]
    if sc = invalid then
        sc = SceneLoad(regionId)
        if sc <> invalid then rw.scenes[regionId] = sc
    end if
    rw.scene = sc
    rw.bubbles = []
end sub

sub RenderBubbles(x as float, y as float, n as integer, spread as float)
    rw = m.rw
    if rw.bubbles.Count() > 40 then return
    for i = 1 to n
        rw.bubbles.Push({ x: x + (Rnd(0) - 0.5) * spread, y: y + (Rnd(0) - 0.5) * spread, vy: 0.8 + Rnd(0) * 1.4, life: 1.2 + Rnd(0) * 1.2, s: 0.25 + Rnd(0) * 0.5, wob: Rnd(0) * 6.28 })
    end for
end sub

' Water colour at a depth (0 = surface .. 1 = seabed) for a biome and daylight, as [r,g,b] 0..255.
function WaterColor(biome as string, depth as float, dl as float) as object
    b = invalid
    if m.biomes <> invalid then b = m.biomes[LCase(biome)]
    if b = invalid then return [20, 90, 140]
    if depth < 0 then depth = 0.0
    if depth > 1 then depth = 1.0
    k = depth ^ 0.8
    dt = b.day_top
    dd = b.day_deep
    nt = b.night_top
    nd = b.night_deep
    out = []
    for i = 0 to 2
        day = dt[i] + (dd[i] - dt[i]) * k
        night = nt[i] + (nd[i] - nt[i]) * k
        out.Push(Int(night + (day - night) * dl))
    end for
    ' dawn and dusk warm the upper water
    warm = 4 * dl * (1 - dl) * (1 - depth)
    out[0] = Int(out[0] + 40 * warm)
    out[1] = Int(out[1] + 8 * warm)
    if out[0] > 255 then out[0] = 255
    if out[1] > 255 then out[1] = 255
    return out
end function

sub RenderWorld(w as object, dt as float, alpha as float, paused as boolean)
    rw = m.rw
    cam = m.cam
    scr = m.screen
    if not paused then rw.t = rw.t + dt
    t = rw.t
    ppu = cam.ppu
    camX = cam.x
    camY = cam.y
    cx = 640 + cam.ox
    cy = 360 + cam.oy
    hw = cam.halfW + 0.6
    hh = cam.halfH + 0.6
    rr = w.rr
    dl = w.dl
    canRot = m.caps.rotate
    canTint = m.caps.tint

    sector = SectorOf(camX, camY)
    biome = rr.sectors[sector].biome
    if biome <> rw.biome then
        rw.prevBiome = rw.biome
        rw.biome = biome
        rw.biomeMix = 0.0
    end if
    if rw.biomeMix < 1 then
        rw.biomeMix = rw.biomeMix + dt * 2.2
        if rw.biomeMix > 1 then rw.biomeMix = 1.0
    end if

    ' ---- water gradient (top colour fill + gradient sprite tinted with the bottom colour)
    dTop = 1 - (camY + cam.halfH) / 40.5
    dBot = 1 - (camY - cam.halfH) / 40.5
    cTop = WaterColor(biome, dTop, dl)
    cBot = WaterColor(biome, dBot, dl)
    if rw.biomeMix < 1 then
        pTop = WaterColor(rw.prevBiome, dTop, dl)
        pBot = WaterColor(rw.prevBiome, dBot, dl)
        k = rw.biomeMix
        for i = 0 to 2
            cTop[i] = Int(pTop[i] + (cTop[i] - pTop[i]) * k)
            cBot[i] = Int(pBot[i] + (cBot[i] - pBot[i]) * k)
        end for
    end if
    scr.Clear(Rgba(cTop[0], cTop[1], cTop[2], 255))
    grad = m.spr["fx_grad"]
    if grad <> invalid then
        g = grad.parts[0]
        scr.DrawScaledObject(0, 0, 1280.0 / g.w, 720.0 / g.h, g.r0, Rgba(cBot[0], cBot[1], cBot[2], 255))
    end if

    ' ---- light for this depth and time
    row = 2 - camY / 13.5
    if row < 0 then row = 0.0
    if row > 2 then row = 2.0
    light = LightFor(dl, row, biome)
    lightCol = -1
    if canTint then lightCol = LightColor(light)
    rw.light = light
    rw.lightCol = lightCol

    RenderBackdrop(w, rr, biome, sector, t, dl, light)

    ' Animals are lit a little more generously than the scenery in dim water, so they still read
    ' on a television at night and at depth (no change in full daylight).
    light = [light[0] + (1 - light[0]) * 0.3, light[1] + (1 - light[1]) * 0.3, light[2] + (1 - light[2]) * 0.3]
    if canTint then lightCol = LightColor(light)

    ' ---- scenery: the camera sits in one sector; while panning the neighbours are visible too
    scene = rw.scene
    secs = []
    if scene <> invalid then
        col0 = sector MOD 3
        row0 = sector \ 3
        for dr = -1 to 1
            r2 = row0 + dr
            if r2 >= 0 and r2 <= 2 then
                for dc = -1 to 1
                    c2 = (col0 + dc + 3) MOD 3
                    ' sector rectangle against the view
                    sxc = c2 * 24.0 + 12.0
                    syc = (2 - r2) * 13.5 + 6.75
                    ddx = DxWrap(camX, sxc)
                    if ddx < 0 then ddx = -ddx
                    ddy = syc - camY
                    if ddy < 0 then ddy = -ddy
                    ' pieces can overhang their sector (tall pillars), hence the margin
                    if ddx < 12 + hw + 2.5 and ddy < 6.75 + hh + 2.5 then
                        sec = scene.sectors[r2 * 3 + c2]
                        SceneRelight(sec, dl)
                        secs.Push(sec)
                    end if
                end for
            end if
        end for
        if not m.lowFx then
            for each sec in secs
                SceneDrawLayer(sec.layers[0], camX, camY, ppu, cx, cy, hw, hh, t, canRot)
            end for
        end if
        ' the body of the seabed: one rectangle from just under the sand line to the screen bottom
        if camY - hh < 1.2 then
            sy0 = cy - Int((0.25 - camY) * ppu)
            if sy0 < 720 then
                bs = scene.sectors[6 + sector MOD 3]
                scr.DrawRect(0, sy0, 1280, 720 - sy0, bs.sandCol)
            end if
        end if
        for each sec in secs
            SceneDrawLayer(sec.layers[1], camX, camY, ppu, cx, cy, hw, hh, t, canRot)
        end for
        for each sec in secs
            SceneDrawLayer(sec.layers[2], camX, camY, ppu, cx, cy, hw, hh, t, canRot)
        end for
    else
        RenderDebugTerrain(rr, camX, camY, ppu, cx, cy, hw, hh)
    end if

    RenderPasses(w, rr, camX, camY, ppu, cx, cy, hw, hh, t)

    ' ---- creatures: rooted and crawling life first, then swimmers, the player last
    back = rw.back
    swim = rw.swim
    back.Clear()
    swim.Clear()
    p = w.player
    pid = -1
    if p <> invalid then pid = p.id
    act = w.act
    n = act.Count()
    rt = w.time + m.game.acc
    for i = 0 to n - 1
        c = act[i]
        if not c.removed then
            ' position between the creature's last two movement states
            a = 1.0
            st = c.simAt - c.pAt
            if st > 0.0001 and not paused then
                a = (rt - st - c.pAt) / st
                if a < 0 then
                    a = 0.0
                else if a > 1 then
                    a = 1.0
                end if
            end if
            ddx = c.x - c.px
            if ddx > 36 then
                ddx = ddx - 72
            else if ddx < -36 then
                ddx = ddx + 72
            end if
            x = c.px + ddx * a
            dx = x - camX
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            ext = c.length * 0.9 + 0.5
            if dx < hw + ext and dx > -hw - ext then
                y = c.py + (c.y - c.py) * a
                dy = y - camY
                if dy < hh + ext and dy > -hh - ext then
                    c.scrX = cx + Int(dx * ppu)
                    c.scrY = cy - Int(dy * ppu)
                    if not paused then CreatureAnimate(c, dt)
                    if c.id <> pid then
                        if c.sp.mobile and c.surface = invalid then
                            swim.Push(c)
                        else
                            back.Push(c)
                        end if
                    end if
                end if
            end if
        end if
    end for
    now = w.time
    for each c in back
        RenderOneCreature(w, c, ppu, lightCol, light, now, t, dl)
    end for
    RenderEffects(w, camX, camY, ppu, cx, cy, hw, hh, t, false)
    for each c in swim
        RenderOneCreature(w, c, ppu, lightCol, light, now, t, dl)
    end for
    if p <> invalid then
        if not p.removed then RenderOneCreature(w, p, ppu, lightCol, light, now, t, dl)
    end if
    RenderEffects(w, camX, camY, ppu, cx, cy, hw, hh, t, true)

    ' ---- foreground cover
    if scene <> invalid then
        for each sec in secs
            SceneDrawLayer(sec.layers[3], camX, camY, ppu, cx, cy, hw, hh, t, canRot)
        end for
    end if

    RenderParticles(w, dt, camX, camY, ppu, cx, cy, hw, hh, t, paused, light)
    RenderRings(w, ppu, t)
    RenderScreenFx(w, dt)
end sub

sub RenderOneCreature(w as object, c as object, ppu as float, lightCol as integer, light as object, now as float, t as float, dl as float)
    col = lightCol
    a = 255
    special = false
    r = light[0]
    g = light[1]
    b = light[2]
    if c.isPlayer and r < 0.8 then
        ' your own fish is always the easiest thing to find
        r = r + (1 - r) * 0.4
        g = g + (1 - g) * 0.4
        b = b + (1 - b) * 0.4
        special = true
    end if
    if not c.alive then
        k = 1 - (now - c.diedAt) / 2.5
        if c.isPlayer then k = 1 - (now - c.diedAt) / 4.0
        if k < 0 then k = 0.0
        a = Int(255 * k)
        special = true
    else
        if c.visibility < 0.6 then
            ' tucked into cover or camouflaged: drawn faint (the player a little less so)
            v = c.visibility
            if c.isPlayer then
                a = Int(150 + 170 * v)
            else
                a = Int(105 + 240 * v)
            end if
            if a > 255 then a = 255
            special = true
        end if
        if now - c.hurtAt < 0.25 then
            g = g * 0.45
            b = b * 0.45
            special = true
        else if c.venom > 0.3 then
            r = r * 0.75
            b = b * 0.7
            special = true
        end if
        if c.sp.emissive <> "" and dl < 0.6 then
            ' bioluminescent species keep their own light at night
            k = 1 - dl
            r = r + (1 - r) * k
            g = g + (1 - g) * k
            b = b + (1 - b) * k
            special = true
        end if
    end if
    if special and m.caps.tint then col = Rgba(Int(r * 255), Int(g * 255), Int(b * 255), a)
    y = c.scrY
    if c.groundY >= 0 then
        spr = c.spr
        if spr = invalid then
            spr = m.spr[c.sp.sprite]
            c.spr = spr
        end if
        if spr <> invalid then
            if spr.base = 1 then y = y + Int((c.y - c.groundY) * ppu)
        end if
    end if
    ' glow behind light-emitting animals at night
    if c.alive and dl < 0.6 then
        lit = false
        if c.abCount > 0 then lit = c.ab.DoesExist("illuminate")
        if lit or c.sp.emissive <> "" then
            gl = m.spr["fx_glow"]
            if gl <> invalid then
                s = c.length * ppu / 128.0 * 2.6
                if lit then s = s * 2.2
                ga = Int((1 - dl) * 150)
                gc = &h9FF4FF00 + ga
                if c.sp.emissive <> "" then gc = HexColor(c.sp.emissive, ga)
                m.screen.DrawScaledObject(c.scrX, y, s, s, gl.parts[0].r0, gc)
            end if
        end if
    end if
    DrawCreature(c, c.scrX, y, ppu, col, t)
end sub

' World effects (ink, pulses, sparkles ...). `front` selects the pass drawn over the swimmers.
sub RenderEffects(w as object, camX as float, camY as float, ppu as float, cx as integer, cy as integer, hw as float, hh as float, t as float, front as boolean)
    fx = w.effects
    if fx.Count() = 0 then return
    scr = m.screen
    now = w.time
    for each e in fx
        kind = e.kind
        isFront = (kind <> "ink")
        if isFront = front then
            dx = DxWrap(camX, e.x)
            dy = e.y - camY
            ext = e.r + 1
            if dx < hw + ext and dx > -hw - ext and dy < hh + ext and dy > -hh - ext then
                x = cx + Int(dx * ppu)
                y = cy - Int(dy * ppu)
                age = now - e.t0
                k = age / e.dur
                if k > 1 then k = 1.0
                if kind = "ink" then
                    s = m.spr["fx_ink"]
                    if s <> invalid then
                        grow = age / 0.6
                        if grow > 1 then grow = 1.0
                        fade = age - e.dur + 1
                        if fade < 0 then fade = 0.0
                        a = Int(235 * (1 - fade))
                        sc = e.r * grow * ppu / 128.0 * 2.1
                        reg = s.parts[0].r0
                        scr.DrawScaledObject(x, y, sc, sc * 0.9, reg, &h0A0A1400 + a)
                        scr.DrawScaledObject(x + Int(Sin(t * 0.9) * sc * 22), y - Int(sc * 18), sc * 0.7, sc * 0.7, reg, &h0A0A1400 + a)
                        scr.DrawScaledObject(x - Int(Cos(t * 0.7) * sc * 26), y + Int(sc * 12), sc * 0.62, sc * 0.62, reg, &h0A0A1400 + a)
                    end if
                else if kind = "pulse" or kind = "sonic" or kind = "mimic" or kind = "spines" or kind = "sting" then
                    s = m.spr["fx_wave"]
                    if s <> invalid then
                        sc = e.r * (0.25 + 0.75 * k) * ppu / 128.0 * 2
                        a = Int(230 * (1 - k))
                        c0 = &hBFE9FF00
                        if kind = "pulse" then
                            c0 = &hFFF58A00
                        else if kind = "spines" or kind = "sting" then
                            c0 = &hFF8A7A00
                        else if kind = "mimic" then
                            c0 = &h8AD8FF00
                            a = a \ 2
                        end if
                        scr.DrawScaledObject(x, y, sc, sc, s.parts[0].r0, c0 + a)
                        if kind = "pulse" then
                            z = m.spr["fx_zap"]
                            if z <> invalid then scr.DrawScaledObject(x, y, sc * 0.8, sc * 0.8, z.parts[0].r0, &hFFFFFF00 + a)
                        end if
                    end if
                else if kind = "heal" then
                    s = m.spr["fx_sparkle"]
                    if s <> invalid then
                        a = Int(255 * (1 - k))
                        for i = 0 to 2
                            ox = Int(Sin(i * 2.1 + e.t0 * 7) * ppu * 0.45)
                            scr.DrawScaledObject(x + ox, y - Int(k * ppu * 0.9) - i * 9, 0.5, 0.5, s.parts[0].r0, &h9FFFD800 + a)
                        end for
                    end if
                else if kind = "poison" then
                    s = m.spr["fx_bubble"]
                    if s <> invalid then
                        a = Int(220 * (1 - k))
                        for i = 0 to 3
                            ox = Int(Sin(i * 1.9 + e.t0 * 5) * ppu * 0.4)
                            scr.DrawScaledObject(x + ox, y - Int(k * ppu * 0.8) - i * 7, 0.6, 0.6, s.parts[0].r0, &h9CFF6A00 + a)
                        end for
                    end if
                else if kind = "chomp" then
                    s = m.spr["fx_chomp"]
                    if s <> invalid then
                        sc = e.r * (0.5 + 0.8 * k) * ppu / 128.0 * 2
                        if sc < 0.25 then sc = 0.25
                        scr.DrawScaledObject(x, y, sc, sc, s.parts[0].r0, &hFFFFFF00 + Int(255 * (1 - k)))
                    end if
                else if kind = "lure" then
                    s = m.spr["fx_glow"]
                    if s <> invalid then
                        sc = (0.5 + 0.2 * Sin(t * 9)) * ppu / 128.0 * 1.6
                        scr.DrawScaledObject(x, y, sc, sc, s.parts[0].r0, &hFFE58AC8)
                    end if
                end if
            end if
        end if
    end for
end sub

' Marine snow drifting in screen space, plus bubbles released by events (world space).
sub RenderParticles(w as object, dt as float, camX as float, camY as float, ppu as float, cx as integer, cy as integer, hw as float, hh as float, t as float, paused as boolean, light as object)
    scr = m.screen
    rw = m.rw
    mote = m.spr["fx_mote"]
    if mote <> invalid then
        reg = mote.parts[0].r0
        lum = (light[0] + light[1] + light[2]) / 3
        ' the motes drift against camera motion so the water feels deep
        mvx = -m.cam.velX * ppu * 0.25
        mvy = m.cam.velY * ppu * 0.25
        skyY = 360 - Int((40.5 - camY) * ppu)
        skip = false
        lowFx = m.lowFx
        for each q in rw.motes
            ' low detail: every other mote
            if lowFx then skip = not skip
            if not skip then
                if not paused then
                    q.x = q.x + (q.vx + mvx + Sin(t * 0.6 + q.ph) * 6) * dt
                    q.y = q.y + (q.vy + mvy) * dt
                    if q.x < -8 then q.x = q.x + 1296
                    if q.x > 1288 then q.x = q.x - 1296
                    if q.y < -8 then q.y = q.y + 736
                    if q.y > 728 then q.y = q.y - 736
                end if
                if q.y > skyY then scr.DrawScaledObject(Int(q.x), Int(q.y), q.s, q.s, reg, &hDFF6FF00 + Int(q.a * lum))
            end if
        end for
    end if
    bl = rw.bubbles
    if bl.Count() > 0 then
        bub = m.spr["fx_bubble"]
        i = bl.Count() - 1
        while i >= 0
            q = bl[i]
            if not paused then
                q.life = q.life - dt
                q.y = q.y + q.vy * dt
                q.vy = q.vy + 0.6 * dt
            end if
            if q.life <= 0 then
                bl.Delete(i)
            else if bub <> invalid then
                dx = DxWrap(camX, q.x)
                dy = q.y - camY
                if dx < hw and dx > -hw and dy < hh and dy > -hh then
                    a = Int(MinF(1.0, q.life) * 200)
                    scr.DrawScaledObject(cx + Int((dx + Sin(t * 3 + q.wob) * 0.05) * ppu), cy - Int(dy * ppu), q.s * ppu / 80.0, q.s * ppu / 80.0, bub.parts[0].r0, &hFFFFFF00 + a)
                end if
            end if
            i = i - 1
        end while
    end if
end sub

' Risk rings: what is hunting you, what you can eat, your target and the inspected creature.
sub RenderRings(w as object, ppu as float, t as float)
    p = w.player
    if p = invalid then return
    if not p.alive then return
    scr = m.screen
    ps = w.ps
    now = w.time
    assist = (m.save.settings.halos and w.diff.halos)
    ver = w.playerVersion
    known = w.known
    ringEd = m.spr["ring_edible"]
    passive = []
    for each c in m.rw.swim
        RenderRingFor(w, c, p, ps, ppu, t, assist, ver, known, passive)
    end for
    for each c in m.rw.back
        RenderRingFor(w, c, p, ps, ppu, t, assist, ver, known, passive)
    end for
    ' passive "you can eat this" rings: the nearest five only, so busy scenes stay readable
    if ringEd <> invalid and passive.Count() > 0 then
        if passive.Count() > 5 then passive.SortBy("d")
        n = passive.Count()
        if n > 5 then n = 5
        reg = ringEd.parts[0].r0
        for i = 0 to n - 1
            h = passive[i]
            scr.DrawScaledObject(h.x, h.y, h.s, h.s, reg, &h7CFFB064)
        end for
    end if
    ' a soft ring keeps a small player fish easy to find on a big screen
    if p.vlen * ppu < 70 then
        s = m.spr["ring_player"]
        if s <> invalid then
            sc = MaxF(0.6, p.vlen * 1.6) * ppu / 128.0
            a = Int(70 + 30 * Sin(now * 3))
            scr.DrawScaledObject(p.scrX, p.scrY, sc, sc, s.parts[0].r0, &hBFF6FF00 + a)
        end if
    end if
end sub

sub RenderRingFor(w as object, c as object, p as object, ps as object, ppu as float, t as float, assist as boolean, ver as integer, known as object, passive as object)
    if not c.alive then return
    scr = m.screen
    size = c.length * 1.35
    if size < 0.55 then size = 0.55
    cid = c.id
    b = c.behavior
    if c.targetId = p.id and (b = 3 or b = 13) then
        s = m.spr["ring_threat"]
        if s <> invalid then
            sc = size * 1.1 * ppu / 128.0 * (1 + 0.06 * Sin(t * 8))
            a = Int(190 + 60 * Sin(t * 8))
            scr.DrawScaledObject(c.scrX, c.scrY, sc, sc, s.parts[0].r0, &hFF5A5A00 + a)
        end if
        return
    end if
    isTarget = (ps.targetId = cid)
    inspected = (ps.inspectId = cid)
    if not (isTarget or inspected or assist) then return
    dx = DxWrap(p.x, c.x)
    dy = c.y - p.y
    d2 = dx * dx + dy * dy
    if d2 > 30 and not (isTarget or inspected) then return
    isKnown = known.DoesExist(c.sp.id)
    risk = 0
    if isKnown or isTarget then
        if c.pvStamp <> ver then BrainRefreshPv(w, c, p)
        risk = c.pvRisk
        if risk <> 1 and not (isTarget or inspected) then return
    else
        if not inspected then return
        risk = -1
    end if
    if isTarget then
        s = m.spr["ring_target"]
        if s <> invalid then
            sc = size * 1.15 * ppu / 128.0
            scr.DrawScaledObject(c.scrX, c.scrY, sc, sc, s.parts[0].r0, &hFFFFFFE6)
        end if
    end if
    if not (isTarget or inspected) then
        passive.Push({ d: d2, x: c.scrX, y: c.scrY, s: size * 0.8 * ppu / 128.0 })
        return
    end if
    id = "ring_neutral"
    colr = &hC8D2DCE0
    if risk = 1 then
        id = "ring_edible"
        colr = &h7CFFB0F0
    else if risk = 2 then
        id = "ring_risky"
        colr = &hFFC850F0
    else if risk = 3 then
        id = "ring_danger"
        colr = &hFF6464F0
    else if risk = -1 then
        id = "ring_unknown"
        colr = &hE6E6FFF0
    end if
    s = m.spr[id]
    if s <> invalid then
        sc = size * ppu / 128.0
        if not inspected then sc = sc * 0.8
        scr.DrawScaledObject(c.scrX, c.scrY, sc, sc, s.parts[0].r0, colr)
    end if
end sub

' Reef passes: a glowing ring where the current leads to another region.
sub RenderPasses(w as object, rr as object, camX as float, camY as float, ppu as float, cx as integer, cy as integer, hw as float, hh as float, t as float)
    s = m.spr["fx_pass"]
    if s = invalid then return
    scr = m.screen
    for each q in rr.passes
        dx = DxWrap(camX, q.x)
        dy = q.y - camY
        if dx < hw + 2 and dx > -hw - 2 and dy < hh + 2 and dy > -hh - 2 then
            open = w.cfg.unlocked.DoesExist(q.dest)
            col = &hFF8A7A70
            if open then col = &h7FF5E6C0
            sc = q.r * 2.3 * ppu / 256.0 * (1 + 0.04 * Sin(t * 2))
            x = cx + Int(dx * ppu)
            y = cy - Int(dy * ppu)
            if m.caps.rotate then
                scr.DrawTransformedObject(x, y, t * 20, sc, sc, s.parts[0].r0, col)
            else
                scr.DrawScaledObject(x, y, sc, sc, s.parts[0].r0, col)
            end if
        end if
    end for
end sub

' Full-screen feedback: vignette, damage flash, venom tint, low-energy pulse.
sub RenderScreenFx(w as object, dt as float)
    scr = m.screen
    rw = m.rw
    v = m.spr["fx_vignette"]
    if v <> invalid then
        g = v.parts[0]
        scr.DrawScaledObject(0, 0, 1280.0 / g.w, 720.0 / g.h, g.r0, &h00081AD0)
    end if
    p = w.player
    if p = invalid then return
    now = w.time
    hurt = 0.0
    if now - p.hurtAt < 0.5 then hurt = 1 - (now - p.hurtAt) / 0.5
    rw.dmgFlash = rw.dmgFlash + (hurt - rw.dmgFlash) * MinF(1.0, dt * 8)
    dmg = rw.dmgFlash
    if p.alive then
        low = 1 - p.health / 35.0
        if low > 0 then
            if low > 1 then low = 1.0
            if low * 0.5 > dmg then dmg = low * 0.5
        end if
    else
        dmg = 0.7
    end if
    if dmg > 0.02 and v <> invalid then
        g = v.parts[0]
        scr.DrawScaledObject(0, 0, 1280.0 / g.w, 720.0 / g.h, g.r0, &hC8141400 + Int(dmg * 210))
    end if
    if p.venom > 0.2 then
        a = Int(MinF(1.0, p.venom / 4.0) * 60)
        scr.DrawRect(0, 0, 1280, 720, &h50C83C00 + a)
    end if
    if p.alive and p.energy < 22 and v <> invalid then
        k = (1 - p.energy / 22.0) * (0.6 + 0.4 * Sin(now * 5))
        g = v.parts[0]
        scr.DrawScaledObject(0, 0, 1280.0 / g.w, 720.0 / g.h, g.r0, &h00000000 + Int(k * 170))
    end if
end sub

' Fallback when a region has no scene data: block out the collision field.
sub RenderDebugTerrain(rr as object, camX as float, camY as float, ppu as float, cx as integer, cy as integer, hw as float, hh as float)
    scr = m.screen
    stepW = 0.5
    y = camY - hh
    while y < camY + hh
        runStart = -9999.0
        x = camX - hw
        while x <= camX + hw + stepW
            solid = false
            if x <= camX + hw then solid = (TerrSdfFast(rr, WrapX(x), y) < 0)
            if solid and runStart < -9000 then
                runStart = x
            else if (not solid) and runStart > -9000 then
                scr.DrawRect(cx + Int((runStart - camX) * ppu), cy - Int((y + stepW - camY) * ppu), Int((x - runStart) * ppu) + 1, Int(stepW * ppu) + 1, &h5A5248FF)
                runStart = -9999.0
            end if
            x = x + stepW
        end while
        y = y + stepW
    end while
end sub
