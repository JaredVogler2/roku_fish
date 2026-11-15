' ============================================================================
' hud.brs - the in-game heads-up display (everything drawn over the reef while playing).
'
'   top left      your species, growth stage or ladder stage, the current goal, hunted warning
'   top right     3x3 sector map with cleaning stations, reef passes and predator sightings; clock
'   bottom left   health, energy and growth / stage bars
'   bottom right  abilities (with cooldowns) and score
'   in the reef   target card, floating score, off-screen threat arrows, pass labels, tutorial ring
' ============================================================================

sub HudInit()
    m.hud = { obj: invalid, objAt: -1, frame: 0 }
end sub

sub HudDraw(w as object, dt as float)
    p = w.player
    if p = invalid then return
    hud = m.hud
    ui = m.ui
    scr = m.screen
    ps = w.ps
    sp = p.sp
    md = w.mode
    cam = m.cam
    now = w.time
    hud.frame = hud.frame + 1
    asc = w.cfg.growthMode

    HudWorldMarks(w, p, ps, md)

    ' ---- species chip
    UiPanel(48, 28, 336, 92)
    UiPortrait(sp, 56, 36, 116, 76, true, true)
    scr.DrawText(FitText(sp.name, "smallb", 196), 182, 36, ui.text, m.fonts.smallb)
    meta = ""
    if asc then
        meta = m.bal.growth.milestonenames[ps.milestone] + "  " + Fmt2(p.length / MaxF(0.01, ps.initialLength)) + "x length"
    else if md.id = "tournament" or md.id = "challenge" then
        meta = "Stage " + (md.stage + 1).ToStr() + " of " + md.ladder.Count().ToStr()
    else
        meta = sp.sci
        if meta = invalid or meta = "" then meta = "Free swim"
    end if
    scr.DrawText(FitText(meta, "tiny", 196), 182, 62, ui.gold, m.fonts.tiny)
    scr.DrawText(ModeLabel(w), 182, 86, ui.faint, m.fonts.tiny)
    ix = 366
    if ps.hidden then
        UiIcon("ic_hidden", ix, 100, 0.34, ui.good)
        ix = ix - 24
    end if
    if p.venom > 0.3 then UiIcon("ic_poison", ix, 100, 0.34, &hA8FF6AFF)

    ' ---- objective / tutorial card
    if hud.obj = invalid or hud.frame - hud.objAt > 9 then
        hud.obj = ModeObjective(w)
        hud.objAt = hud.frame
    end if
    o = hud.obj
    y = 128
    if o.title <> "" then
        tut = (md.id = "tutorial" and not md.done)
        lines = WrapText(o.detail, "tiny", 308)
        nl = lines.Count()
        if not tut and nl > 2 then nl = 2
        h = 44 + nl * 22 + 10
        if o.progress >= 0 then h = h + 12
        ni = o.items.Count()
        h = h + ni * 22
        if tut then h = h + 26
        UiPanel(48, y, 336, h)
        tcol = ui.aqua
        if tut then tcol = ui.gold
        scr.DrawText(FitText(o.title, "smallb", 310), 62, y + 10, tcol, m.fonts.smallb)
        ty = y + 38
        for i = 0 to nl - 1
            scr.DrawText(lines[i], 62, ty, ui.dim, m.fonts.tiny)
            ty = ty + 22
        end for
        if o.progress >= 0 then
            UiBar(62, ty + 4, 308, 7, o.progress, ui.gold)
            ty = ty + 16
        end if
        for each it in o.items
            t = "- " + it.text
            if it.progress > 0.01 and it.progress < 1 then t = t + " (" + UiPercent(it.progress) + ")"
            scr.DrawText(FitText(t, "tiny", 308), 62, ty, ui.text, m.fonts.tiny)
            ty = ty + 22
        end for
        if tut then scr.DrawText("* next tip    Play/Pause: skip tutorial", 62, ty + 2, ui.faint, m.fonts.tiny)
        y = y + h + 8
    end if

    ' ---- hunted warning
    if ps.chasedCount > 0 and p.alive then
        txt = ""
        if ps.chasedCount = 1 then
            for each key in ps.chasedBy
                c = WorldGet(w, key.ToInt())
                if c <> invalid then txt = c.sp.name
            end for
        end if
        line2 = "is hunting you! Hide or flee."
        if txt = "" then
            txt = ps.chasedCount.ToStr() + " predators"
            line2 = "are hunting you! Hide or flee."
        end if
        a = Int(200 + 55 * Sin(now * 7))
        UiRound(48, y, 336, 54, &hB0202A00 + a)
        UiIcon("ic_alert", 76, y + 27, 0.5, &hFFFFFFFF)
        scr.DrawText(FitText(txt, "smallb", 262), 104, y + 5, &hFFFFFFFF, m.fonts.smallb)
        scr.DrawText(line2, 104, y + 28, &hFFE0E0FF, m.fonts.tiny)
        HudThreatArrows(w, p, ps)
    end if

    HudMinimap(w, p)

    ' ---- bars
    third = (asc or md.id = "tournament" or md.id = "challenge")
    bh = 82
    if third then bh = 110
    by = 692 - bh
    UiPanel(48, by, 336, bh)
    hp = p.health / p.maxHealth
    hc = ui.coral
    if hp < 0.3 and Int(now * 4) MOD 2 = 0 then hc = &hFFFFFFFF
    HudBarRow("ic_heart", "HEALTH", by + 12, hp, hc, Int(p.health + 0.99).ToStr())
    en = p.energy / 100.0
    ec = ui.aqua
    if en < 0.22 and Int(now * 4) MOD 2 = 0 then ec = &hFFFFFFFF
    HudBarRow("ic_bolt", "ENERGY", by + 40, en, ec, Int(p.energy + 0.99).ToStr())
    if third then
        lbl = "GROWTH"
        if not asc then lbl = "STAGE"
        pr = o.progress
        if pr < 0 then pr = 0.0
        HudBarRow("ic_grow", lbl, by + 68, pr, ui.gold, UiPercent(pr))
    end if

    ' ---- score and abilities
    UiPanel(1076, 616, 156, 76)
    DrawTextR(FmtInt(ps.score), 1218, 622, ui.gold, "head")
    DrawTextR("SCORE", 1218, 660, ui.faint, "tiny")
    ax = 1076 - 88
    if ps.secondary <> "" and ps.secondary <> "none" then
        HudAbility(w, p, ps.secondary, ax, 616, "*")
        ax = ax - 88
    end if
    if ps.primary <> "" and ps.primary <> "none" then HudAbility(w, p, ps.primary, ax, 616, "<<")

    ' ---- feedback line / first-minute controls reminder (between the bars and the abilities)
    if ps.feedback <> "" and now - ps.feedbackAt < 3.2 then
        lines = WrapText(ps.feedback, "small", 500)
        nl = lines.Count()
        if nl > 2 then nl = 2
        tw = 0
        for i = 0 to nl - 1
            lw = TextWidth(lines[i], "small")
            if lw > tw then tw = lw
        end for
        tw = tw + 36
        h = 16 + nl * 26
        UiRound(686 - tw \ 2, 692 - h, tw, h, &h04182CE6)
        for i = 0 to nl - 1
            DrawTextC(lines[i], 686, 692 - h + 8 + i * 26, ui.text, "small")
        end for
    else if m.save.settings.hints and ps.timeAlive < 40 and md.id <> "tutorial" then
        t = "OK bite    << ability    >> sprint    Replay inspect    Play/Pause menu"
        tw = TextWidth(t, "tiny") + 36
        UiRound(686 - tw \ 2, 658, tw, 34, &h04182CC8)
        DrawTextC(t, 686, 665, ui.dim, "tiny")
    end if

    HudToasts()
end sub

sub HudBarRow(icon as string, label as string, y as integer, frac as float, color as integer, value as string)
    scr = m.screen
    UiIcon(icon, 72, y + 11, 0.34, color)
    scr.DrawText(label, 90, y, m.ui.dim, m.fonts.tiny)
    UiBar(170, y + 5, 158, 12, frac, color)
    DrawTextR(value, 372, y, m.ui.text, "tiny")
end sub

sub HudAbility(w as object, p as object, id as string, x as integer, y as integer, key as string)
    scr = m.screen
    ui = m.ui
    def = m.abilities[id]
    if def = invalid then return
    now = w.time
    cd = CooldownLeft(p, id, now)
    active = false
    if p.abCount > 0 then active = p.ab.DoesExist(id)
    fill = ui.panel
    if active then fill = &h1C7A52F0
    UiRound(x, y, 80, 76, fill)
    col = ui.text
    if cd > 0 and not active then col = &h7C97A8FF
    if active then col = ui.good
    UiIcon("ic_" + LCase(id), x + 40, y + 30, 0.62, col)
    if cd > 0 and not active then
        ' cooldown: a shade that drains away plus the seconds left
        frac = cd / MaxF(0.1, def.cooldown)
        if frac > 1 then frac = 1.0
        scr.DrawRect(x + 6, y + 6, 68, Int(48 * frac), &h02101EA0)
        DrawTextC(Int(cd + 0.99).ToStr(), x + 40, y + 16, ui.text, "smallb")
    end if
    kw = TextWidth(key, "tiny") + 14
    UiRound(x + 40 - kw \ 2, y + 52, kw, 28, &hEAF8FFE8)
    scr.DrawText(key, x + 40 - kw \ 2 + 7, y + 56, ui.ink, m.fonts.tiny)
end sub

sub HudMinimap(w as object, p as object)
    scr = m.screen
    ui = m.ui
    rr = w.rr
    now = w.time
    x0 = 1036
    y0 = 28
    UiPanel(x0, y0, 196, 176)
    scr.DrawText(FitText(rr.sectors[p.sector].name, "tiny", 176), x0 + 12, y0 + 8, ui.text, m.fonts.tiny)
    gx = x0 + 12
    gy = y0 + 36
    for i = 0 to 8
        cx = gx + (i MOD 3) * 58
        cy = gy + (i \ 3) * 32
        fill = &h0A2A4490
        if w.visited.DoesExist(i.ToStr()) then fill = &h1A5478C8
        if i = p.sector then fill = &h2E9CC8F0
        scr.DrawRect(cx, cy, 55, 29, fill)
    end for
    for each st in rr.stations
        cx = gx + (st.sector MOD 3) * 58
        cy = gy + (st.sector \ 3) * 32
        UiIcon("ic_clean", cx + 10, cy + 9, 0.2, ui.good)
    end for
    for each q in rr.passes
        cx = gx + (q.sector MOD 3) * 58
        cy = gy + (q.sector \ 3) * 32
        col = &h8FA8B8FF
        if w.cfg.unlocked.DoesExist(q.dest) then col = ui.aqua
        UiIcon("ic_pass", cx + 10, cy + 21, 0.2, col)
    end for
    for each s in w.sightings
        if now - s.at < 25 then
            cx = gx + (s.sector MOD 3) * 58
            cy = gy + (s.sector \ 3) * 32
            UiIcon("ic_alert", cx + 45, cy + 20, 0.22, ui.bad)
        end if
    end for
    ' you
    cx = gx + (p.sector MOD 3) * 58
    cy = gy + (p.sector \ 3) * 32
    UiIcon("ic_fish", cx + 28, cy + 14, 0.34, &hFFFFFFFF)
    ' clock
    ic = "ic_sun"
    if w.phase = 0 then
        ic = "ic_moon"
    else if w.phase <> 2 then
        ic = "ic_dusk"
    end if
    UiIcon(ic, x0 + 22, y0 + 154, 0.3, ui.gold)
    scr.DrawText(ClockString(w.dayTime) + " " + PhaseLabel(w.phase), x0 + 38, y0 + 143, ui.dim, m.fonts.tiny)
end sub

' Things drawn at reef positions: target card, floating scores, pass labels, tutorial marker.
sub HudWorldMarks(w as object, p as object, ps as object, md as object)
    scr = m.screen
    ui = m.ui
    cam = m.cam
    ppu = cam.ppu
    g = m.game
    tms = NowMs()

    ' tutorial ring
    if md.marker <> invalid and md.id = "tutorial" and not md.done then
        dx = DxWrap(cam.x, md.marker.x)
        dy = md.marker.y - cam.y
        s = m.spr["fx_marker"]
        if s <> invalid then
            if dx > -cam.halfW and dx < cam.halfW and dy > -cam.halfH and dy < cam.halfH then
                sc = (1.0 + 0.12 * Sin(w.time * 5)) * ppu / 128.0 * 1.3
                scr.DrawScaledObject(640 + Int(dx * ppu), 360 - Int(dy * ppu), sc, sc, s.parts[0].r0, &hFFE58AE6)
            else
                HudEdgeArrow(dx, dy, &hFFE58AFF)
            end if
        end if
    end if

    ' reef pass labels
    for each q in w.rr.passes
        dx = DxWrap(cam.x, q.x)
        dy = q.y - cam.y
        if dx > -cam.halfW + 1 and dx < cam.halfW - 1 and dy > -cam.halfH + 1 and dy < cam.halfH - 1 then
            x = 640 + Int(dx * ppu)
            y = 360 - Int((dy + q.r + 0.5) * ppu)
            open = w.cfg.unlocked.DoesExist(q.dest)
            t = "Reef pass to the " + RegionName(q.dest)
            t2 = "Swim into the current to travel."
            if not open then
                t2 = "Locked - advance further to open it."
                if w.cfg.growthMode then t2 = "Locked - grow larger to brave the current."
            end if
            tw = MaxF(TextWidth(t, "tiny"), TextWidth(t2, "tiny")) + 28
            if x - tw \ 2 < 48 then x = 48 + tw \ 2
            if x + tw \ 2 > 1232 then x = 1232 - tw \ 2
            if y < 40 then y = 40
            UiRound(x - tw \ 2, y - 50, tw, 54, &h04182CD8)
            DrawTextC(t, x, y - 46, ui.aqua, "tiny")
            DrawTextC(t2, x, y - 24, ui.dim, "tiny")
        end if
    end for

    ' target / inspected creature card
    tid = ps.targetId
    inspected = false
    if ps.inspectId >= 0 then
        tid = ps.inspectId
        inspected = true
    end if
    if tid >= 0 then
        c = WorldGet(w, tid)
        if c <> invalid then
            if c.alive and not c.removed then
                if c.pvStamp <> w.playerVersion then BrainRefreshPv(w, c, p)
                known = (w.known.DoesExist(c.sp.id) or inspected)
                nm = "Unknown creature"
                if known then nm = c.sp.name
                risk = c.pvRisk
                lbl = "NOT FOOD"
                col = &hC8D2DCFF
                if not known then
                    lbl = "UNKNOWN"
                    col = &hE6E6FFFF
                else if risk = 1 then
                    lbl = "EDIBLE"
                    col = ui.good
                else if risk = 2 then
                    lbl = "RISKY"
                    col = ui.warn
                else if risk = 3 then
                    lbl = "DANGER"
                    col = ui.bad
                end if
                why = c.pvReason
                if not known then why = "Bite it or inspect it (Replay) to learn what it is."
                if inspected then why = why + "  It is " + BehaviorName(c.behavior) + "."
                cw = 390
                lines = WrapText(why, "tiny", cw - 30)
                nl = lines.Count()
                if nl > 3 then nl = 3
                h = 40 + nl * 21 + 8
                x = c.scrX + Int(c.length * ppu * 0.6) + 18
                y = c.scrY - h \ 2
                if x + cw > 1232 then x = c.scrX - Int(c.length * ppu * 0.6) - 18 - cw
                if x < 48 then x = 48
                if y < 130 then y = 130
                if y + h > 570 then y = 570 - h
                UiRound(x, y, cw, h, &h04182CE6)
                scr.DrawRect(x, y + 14, 4, h - 28, col)
                scr.DrawText(FitText(nm, "smallb", cw - 120), x + 14, y + 8, ui.text, m.fonts.smallb)
                DrawTextR(lbl, x + cw - 12, y + 10, col, "tiny")
                ty = y + 36
                for i = 0 to nl - 1
                    scr.DrawText(lines[i], x + 14, ty, ui.dim, m.fonts.tiny)
                    ty = ty + 21
                end for
            end if
        end if
    end if

    ' floating score and damage numbers
    fl = g.floats
    i = fl.Count() - 1
    while i >= 0
        f = fl[i]
        age = (tms - f.t0) / 1000.0
        if age > 1.15 then
            fl.Delete(i)
        else
            dx = DxWrap(cam.x, f.x)
            dy = f.y - cam.y
            a = 255
            if age > 0.7 then a = Int(255 * (1.15 - age) / 0.45)
            DrawTextShadowC(f.text, 640 + Int(dx * ppu), 360 - Int((dy + 0.5 + age * 1.1) * ppu), WithAlpha(f.color, a), "bodyb")
        end if
        i = i - 1
    end while
end sub

' Arrow on the screen edge pointing at something off-screen (dx, dy in world units from the camera).
sub HudEdgeArrow(dx as float, dy as float, color as integer)
    s = m.spr["fx_arrow"]
    if s = invalid then return
    ang = Atan2(dy, dx)
    cs = Cos(ang)
    sn = Sin(ang)
    kx = 9999.0
    ky = 9999.0
    if Abs(cs) > 0.001 then kx = 580 / Abs(cs)
    if Abs(sn) > 0.001 then ky = 300 / Abs(sn)
    k = kx
    if ky < k then k = ky
    x = 640 + Int(cs * k)
    y = 360 - Int(sn * k)
    if m.caps.rotate then
        m.screen.DrawTransformedObject(x, y, ang * 57.29578, 1.0, 1.0, s.parts[0].r0, color)
    else
        m.screen.DrawObject(x, y, s.parts[0].r0, color)
    end if
end sub

sub HudThreatArrows(w as object, p as object, ps as object)
    cam = m.cam
    a = Int(200 + 55 * Sin(w.time * 9))
    for each key in ps.chasedBy
        c = WorldGet(w, key.ToInt())
        if c <> invalid then
            dx = DxWrap(cam.x, c.x)
            dy = c.y - cam.y
            if dx < -cam.halfW or dx > cam.halfW or dy < -cam.halfH or dy > cam.halfH then HudEdgeArrow(dx, dy, &hFF5A5A00 + a)
        end if
    end for
end sub

sub HudToasts()
    g = m.game
    ui = m.ui
    ts = g.toasts
    now = NowMs()
    i = ts.Count() - 1
    while i >= 0
        if now > ts[i].until then ts.Delete(i)
        i = i - 1
    end while
    y = 30
    for each t in ts
        tw = TextWidth(t.text, "small") + 44
        if tw > 600 then tw = 600
        left = t.until - now
        a = 230
        if left < 400 then a = Int(230 * left / 400)
        col = ui.text
        edge = ui.aqua
        if t.kind = "good" then edge = ui.gold
        if t.kind = "bad" then edge = ui.bad
        UiRound(640 - tw \ 2, y, tw, 40, &h04182C00 + a)
        m.screen.DrawRect(640 - tw \ 2 + 14, y + 37, tw - 28, 2, WithAlpha(edge, a))
        DrawTextC(FitText(t.text, "small", tw - 30), 640, y + 8, WithAlpha(col, a), "small")
        y = y + 46
    end for
end sub
