' ============================================================================
' overlays.brs - panels shown over a run: pause menu, reef map, controls, death, stage cleared,
' upgrade choice and the end-of-run summary. The simulation is paused while any of them is up.
' ============================================================================

' ---------------------------------------------------------------- pause
sub PauseOpen()
    w = m.game.w
    rows = []
    rows.Push({ kind: "button", id: "resume", label: "Resume", primary: true })
    rows.Push({ kind: "button", id: "guide", label: "Field Guide" })
    rows.Push({ kind: "button", id: "map", label: "Reef map" })
    rows.Push({ kind: "button", id: "controls", label: "Controls" })
    rows.Push({ kind: "button", id: "settings", label: "Settings" })
    if w.mode.id = "tutorial" and not w.mode.done then rows.Push({ kind: "button", id: "skip", label: "Skip the tutorial" })
    rows.Push({ kind: "button", id: "restart", label: "Restart" })
    rows.Push({ kind: "button", id: "quit", label: "Save and exit to menu" })
    m.app.overlay = "pause"
    m.app.ov = { form: FormNew(rows) }
    m.inp.pressed = []
    Sfx("ui_select")
end sub

sub PauseInput()
    app = m.app
    for each key in m.inp.pressed
        if key = 13 then
            app.overlay = ""
            InputClearHeld()
            return
        end if
    end for
    a = FormInput(app.ov.form)
    if a = "" then return
    if a = "back" or a = "resume" then
        app.overlay = ""
        InputClearHeld()
    else if a = "guide" then
        focus = ""
        w = m.game.w
        c = WorldGet(w, w.ps.targetId)
        if c <> invalid then focus = c.sp.id
        app.overlay = "guide"
        GuideEnter(focus)
    else if a = "map" then
        app.overlay = "map"
    else if a = "controls" then
        app.overlay = "controls"
    else if a = "settings" then
        app.overlay = "settings"
        SettingsEnter()
    else if a = "skip" then
        TutorialFinish(m.game.w)
        app.overlay = ""
    else if a = "restart" then
        app.overlay = ""
        GameDeathChoice("restartRun")
        HudInit()
    else if a = "quit" then
        AppQuitToMenu(true, false)
    end if
end sub

sub PauseDraw()
    ui = m.ui
    w = m.game.w
    p = w.player
    UiDim(150)
    UiPanel(420, 70, 440, 590)
    DrawTextC("Paused", 640, 84, ui.text, "head")
    if p <> invalid then
        t = p.sp.name + "  -  " + w.rr.sectors[p.sector].name
        DrawTextC(FitText(t, "tiny", 400), 640, 126, ui.dim, "tiny")
        DrawTextC(ClockString(w.dayTime) + " " + PhaseLabel(w.phase) + "  -  " + RegionName(w.rr.id), 640, 148, ui.faint, "tiny")
    end if
    FormDraw(m.app.ov.form, 444, 184, 392, 470)
end sub

' ---------------------------------------------------------------- reef map
sub MapDraw()
    scr = m.screen
    ui = m.ui
    w = m.game.w
    rr = w.rr
    p = w.player
    now = w.time
    UiDim(160)
    UiTitle(RegionName(rr.id), "The reef wraps around: swim off the left edge to reach the right. Surface and seabed are solid.")
    for i = 0 to 8
        x = 48 + (i MOD 3) * 398
        y = 124 + (i \ 3) * 176
        here = false
        if p <> invalid then here = (p.sector = i)
        seen = (here or w.visited.DoesExist(i.ToStr()))
        fill = &h0A2B45E6
        if here then fill = &h1C6E96F0
        if not seen then fill = &h061C30D8
        UiRound(x, y, 388, 166, fill)
        sec = rr.sectors[i]
        nm = "Unexplored"
        if seen then nm = sec.name
        col = ui.text
        if not seen then col = ui.faint
        scr.DrawText(FitText(nm, "smallb", 330), x + 14, y + 10, col, m.fonts.smallb)
        if here then UiIcon("ic_fish", x + 360, y + 24, 0.4, ui.gold)
        if seen then DrawWrapped(sec.blurb, x + 14, y + 40, 360, ui.dim, "tiny", 3)
        tx = x + 14
        for each st in rr.stations
            if st.sector = i then
                t = "Cleaners: day and night"
                if st.kind = "day" then t = "Cleaners: day"
                if st.kind = "night" then t = "Cleaners: night"
                tx = tx + UiTag(tx, y + 128, t, ui.good) + 6
            end if
        end for
        for each q in rr.passes
            if q.sector = i then
                t = "Pass to " + RegionName(q.dest)
                col = ui.aqua
                if not w.cfg.unlocked.DoesExist(q.dest) then
                    t = t + " (locked)"
                    col = ui.faint
                end if
                if tx + TextWidth(t, "tiny") + 20 < x + 380 then tx = tx + UiTag(tx, y + 128, FitText(t, "tiny", 230), col) + 6
            end if
        end for
        for each s in w.sightings
            if s.sector = i and now - s.at < 40 then
                if tx + 120 < x + 380 then tx = tx + UiTag(tx, y + 128, FitText(s.name + " seen", "tiny", 150), ui.bad) + 6
                exit for
            end if
        end for
    end for
    UiHints([["Back", "Pause menu"]])
end sub

' ---------------------------------------------------------------- death
sub DeathOpen()
    w = m.game.w
    rows = []
    for each o in ModeDeathOptions(w)
        lbl = ""
        if o = "restartStage" then
            lbl = "Continue - restart this stage"
        else if o = "restartRun" then
            lbl = "Restart from the beginning"
        else if o = "continueCheckpoint" then
            if m.game.lastCheckpoint <> invalid then lbl = "Continue from the last growth checkpoint"
        else if o = "respawn" then
            lbl = "Respawn"
        else if o = "menu" then
            lbl = "Exit to menu"
        end if
        if lbl <> "" then rows.Push({ kind: "button", id: o, label: lbl, primary: (rows.Count() = 0) })
    end for
    if w.ps.killer <> "" then
        k = GetSpecies(w.ps.killer)
        if k <> invalid then rows.Push({ kind: "button", id: "lookup", label: "Field Guide: " + k.name })
    end if
    m.app.overlay = "death"
    m.app.ov = { form: FormNew(rows) }
    m.inp.pressed = []
    if w.cfg.mode = "challenge" then GameRecordChallenge(false)
end sub

sub DeathInput()
    app = m.app
    a = FormInput(app.ov.form)
    if a = "" or a = "back" or Left(a, 1) = "~" then return
    if a = "lookup" then
        app.overlay = "guide"
        app.guideReturn = "death"
        GuideEnter(m.game.w.ps.killer)
    else if a = "menu" then
        AppQuitToMenu(true, false)
    else
        app.overlay = ""
        app.ov = invalid
        GameDeathChoice(a)
        HudInit()
    end if
end sub

function DeathHeadline(ps as object) as string
    cause = ps.deathCause
    if cause = "starved" then return "Starved - your energy ran out."
    t = "Lost"
    if cause = "eaten" then
        t = "Eaten"
    else if cause = "bitten" then
        t = "Bitten one time too many"
    else if cause = "poisoned" then
        t = "Poisoned"
    else if cause = "stung" then
        t = "Stung"
    else if cause = "venom" then
        t = "Killed by venom"
    else if cause = "spines" then
        t = "Impaled on spines"
    end if
    if ps.killer <> "" then
        k = GetSpecies(ps.killer)
        if k <> invalid then t = t + " by a " + k.name
    end if
    return t + "."
end function

function DeathTip(cause as string) as string
    if cause = "starved" then return "Eat often - swimming and sprinting burn energy, and bigger bodies burn more. Plankton and worms are reliable early meals."
    if cause = "bitten" then return "After a bite you get a brief burst of speed - use it to reach cover or a cleaning station."
    if cause = "poisoned" then return "Some prey are toxic to you. Check amber and red rings, or the Field Guide, before biting unknown creatures."
    if cause = "spines" then return "Lionfish, urchins and crown-of-thorns defend with spines. Some predators tolerate them - you might not."
    if cause = "venom" then return "Venom fades over time; cleaner wrasse and shrimp can cleanse it."
    if cause = "stung" then return "Sea wasps drift near the surface - keep your distance."
    return "Watch for pulsing red rings and the hunted warning. Duck into caves or dense seagrass and stay still until hunters give up."
end function

sub DeathDraw()
    ui = m.ui
    w = m.game.w
    ps = w.ps
    UiDim(150)
    UiPanel(250, 56, 780, 608)
    DrawTextC(FitText(DeathHeadline(ps), "head", 740), 640, 74, ui.coral, "head")
    y = DrawWrapped(DeathTip(ps.deathCause), 290, 124, 700, ui.dim, "tiny", 3)
    StatsDraw(w, 290, 200, 700, invalid)
    FormDraw(m.app.ov.form, 390, 404, 500, 250)
end sub

' ---------------------------------------------------------------- run statistics
function StatsList(ps as object, score as integer, extra as dynamic) as object
    big = "-"
    if ps.biggestPredator <> "" then
        k = GetSpecies(ps.biggestPredator)
        if k <> invalid then big = k.name
    end if
    out = [
        ["Score", FmtInt(score)]
        ["Time alive", UiTime(ps.timeAlive)]
        ["Prey eaten", ps.preyEaten.ToStr()]
        ["Bites / swallows", ps.bites.ToStr() + " / " + ps.swallows.ToStr()]
        ["Escapes", ps.escapes.ToStr()]
        ["Biggest predator", big]
        ["Toxic mistakes", ps.toxicMistakes.ToStr()]
        ["Healed by cleaners", Int(ps.healed).ToStr() + " HP"]
    ]
    if extra <> invalid then
        for each e in extra
            out.Push(e)
        end for
    end if
    return out
end function

sub StatsDrawList(items as object, x as integer, y as integer, w as integer)
    scr = m.screen
    ui = m.ui
    cw = (w - 3 * 10) \ 4
    i = 0
    for each it in items
        cx = x + (i MOD 4) * (cw + 10)
        cy = y + (i \ 4) * 92
        UiRound(cx, cy, cw, 82, &h0C3250D8)
        DrawTextC(FitText(it[1], "smallb", cw - 12), cx + cw \ 2, cy + 12, ui.text, "smallb")
        DrawTextC(FitText(it[0], "tiny", cw - 8), cx + cw \ 2, cy + 46, ui.faint, "tiny")
        i = i + 1
    end for
end sub

sub StatsDraw(w as object, x as integer, y as integer, width as integer, extra as dynamic)
    StatsDrawList(StatsList(w.ps, w.ps.score, extra), x, y, width)
end sub

' ---------------------------------------------------------------- stage cleared (ladder modes)
sub StageInput()
    g = m.game
    for each key in m.inp.pressed
        if key = 6 then
            Sfx("ui_select")
            sc = g.stageCleared
            if sc.nxt <> "" then
                GameAdvanceStage()
                HudInit()
            else
                w = g.w
                if w.cfg.mode = "challenge" then GameRecordChallenge(true)
                if w.cfg.mode = "tournament" then
                    m.save.tournament = invalid
                    SaveWrite()
                end if
                g.stageCleared = invalid
                AppQuitToMenu(true, true)
            end if
            return
        end if
    end for
end sub

sub StageDraw()
    scr = m.screen
    ui = m.ui
    g = m.game
    w = g.w
    sc = g.stageCleared
    UiDim(150)
    UiPanel(240, 70, 800, 580)
    UiTag(264, 88, "Stage " + (sc.stage + 1).ToStr() + " cleared  -  " + FmtInt(w.ps.score) + " pts", ui.gold)
    if sc.nxt <> "" then
        sp = GetSpecies(sc.nxt)
        scr.DrawText("Next: " + sp.name, 264, 126, ui.text, m.fonts.head)
        UiPortrait(sp, 264, 176, 330, 190)
        y = DrawWrapped(sp.summary, 612, 176, 404, ui.text, "tiny", 6)
        scr.DrawText("Eats", 612, 318, ui.aqua, m.fonts.tiny)
        DrawWrapped(UiDietNames(sp), 612, 340, 404, ui.dim, "tiny", 2)
        scr.DrawText("Ability", 264, 384, ui.aqua, m.fonts.tiny)
        scr.DrawText(FitText(UiAbilityNames(sp), "tiny", 330), 264, 406, ui.dim, m.fonts.tiny)
        scr.DrawText(UiActivity(sp.activity), 612, 406, ui.dim, m.fonts.tiny)
        scr.DrawText("Ecology", 264, 440, ui.aqua, m.fonts.tiny)
        DrawWrapped(sp.fact, 264, 462, 752, ui.dim, "tiny", 3)
        UiRound(390, 572, 500, 58, ui.rowHi)
        DrawTextC(FitText("OK   Become the " + sp.name, "bodyb", 470), 640, 586, ui.ink, "bodyb")
    else
        DrawTextC("Ladder complete!", 640, 190, ui.gold, "big")
        DrawTextC("You climbed the whole food web.", 640, 262, ui.text, "body")
        DrawTextC("Final score: " + FmtInt(w.ps.score), 640, 310, ui.text, "head")
        UiRound(490, 572, 300, 58, ui.rowHi)
        DrawTextC("OK   Finish", 640, 586, ui.ink, "bodyb")
    end if
end sub

' ---------------------------------------------------------------- upgrade choice (Ascension)
sub UpgradeInput()
    ps = m.game.w.ps
    opts = ps.pendingUpgrade
    app = m.app
    if app.ov = invalid then app.ov = { sel: 0 }
    if app.ov.sel = invalid then app.ov = { sel: 0 }
    st = app.ov
    n = opts.Count()
    for each key in m.inp.pressed
        k = key MOD 1000
        if k = 4 then
            st.sel = (st.sel + n - 1) MOD n
            Sfx("ui_move")
        else if k = 5 then
            st.sel = (st.sel + 1) MOD n
            Sfx("ui_move")
        else if key = 6 then
            id = opts[st.sel]
            app.ov = invalid
            GameApplyUpgrade(id, false)
            InputClearHeld()
            return
        end if
    end for
end sub

function UpgradeDef(id as string) as dynamic
    for each u in m.upgrades
        if u.id = id then return u
    end for
    return invalid
end function

function UpgradeIcon(u as object) as string
    if u.grant <> invalid then return "ic_" + LCase(u.grant)
    id = u.id
    if id = "burstTail" or id = "swiftFins" then return "ic_burstsprint"
    if id = "armorScales" then return "ic_defensivespines"
    if id = "keenSenses" then return "ic_camouflage"
    if id = "efficientGills" then return "ic_bolt"
    if id = "quickJaw" then return "ic_fish"
    if id = "poisonTolerance" then return "ic_poison"
    return "ic_star"
end function

sub UpgradeDraw()
    ui = m.ui
    w = m.game.w
    ps = w.ps
    opts = ps.pendingUpgrade
    sel = 0
    if m.app.ov <> invalid then
        if m.app.ov.sel <> invalid then sel = m.app.ov.sel
    end if
    UiDim(150)
    n = opts.Count()
    total = n * 330 + (n - 1) * 20
    x0 = 640 - total \ 2
    UiPanel(x0 - 30, 130, total + 60, 460)
    p = w.player
    UiTag(x0, 150, "Milestone: " + m.bal.growth.milestonenames[ps.milestone] + "  -  " + Fmt2(p.length / MaxF(0.01, ps.initialLength)) + "x length", ui.gold)
    m.screen.DrawText("Your body adapts - choose one", x0, 190, ui.text, m.fonts.head)
    for i = 0 to n - 1
        u = UpgradeDef(opts[i])
        if u <> invalid then
            x = x0 + i * 350
            fill = &h0C3250E6
            fg = ui.text
            sub2 = ui.dim
            if i = sel then
                UiRound(x - 5, 245, 340, 300, &hFFE58A60)
                fill = ui.rowHi
                fg = ui.ink
                sub2 = &h23445CFF
            end if
            UiRound(x, 250, 330, 290, fill)
            UiIcon(UpgradeIcon(u), x + 165, 310, 1.1, fg)
            DrawTextC(u.name, x + 165, 368, fg, "bodyb")
            lines = WrapText(u.description, "tiny", 290)
            ty = 410
            for each ln in lines
                DrawTextC(ln, x + 165, ty, sub2, "tiny")
                ty = ty + 24
            end for
        end if
    end for
    UiHints([["< >", "Choose"], ["OK", "Take it"]])
end sub

' ---------------------------------------------------------------- summary (after leaving a run)
function SummaryBuild(victory as boolean) as dynamic
    w = m.game.w
    if w = invalid then return invalid
    p = w.player
    if p = invalid then return invalid
    ps = w.ps
    extra = []
    md = w.mode
    if w.cfg.growthMode then
        extra.Push(["Final milestone", m.bal.growth.milestonenames[ps.milestone]])
        extra.Push(["Max length", Fmt2(ps.maxLength / MaxF(0.01, ps.initialLength)) + "x hatchling"])
        extra.Push(["Max biomass", Fmt1(ps.maxMass)])
    else if md.id = "tournament" or md.id = "challenge" then
        extra.Push(["Stage reached", (md.stage + 1).ToStr() + " / " + md.ladder.Count().ToStr()])
    end if
    names = []
    for each id in ps.newlyDiscovered
        sp = GetSpecies(id)
        if sp <> invalid then names.Push(sp.name)
    end for
    title = "Run over"
    if victory then title = "Run complete!"
    return { title: title, line: p.sp.name + "  -  " + ModeLabel(w), items: StatsList(ps, ps.score, extra), found: names }
end function

sub SummaryInput()
    for each key in m.inp.pressed
        if key = 6 or key = 0 then
            Sfx("ui_select")
            m.app.overlay = ""
            m.app.summary = invalid
            return
        end if
    end for
end sub

sub SummaryDraw()
    ui = m.ui
    s = m.app.summary
    if s = invalid then return
    UiDim(170)
    UiPanel(190, 60, 900, 600)
    DrawTextC(s.title, 640, 78, ui.gold, "head")
    DrawTextC(s.line, 640, 122, ui.dim, "small")
    StatsDrawList(s.items, 220, 164, 840)
    rows = (s.items.Count() + 3) \ 4
    y = 164 + rows * 92 + 8
    if s.found.Count() > 0 then
        m.screen.DrawText("Newly discovered (" + s.found.Count().ToStr() + ")", 220, y, ui.aqua, m.fonts.smallb)
        t = ""
        for each nm in s.found
            if t <> "" then t = t + ", "
            t = t + nm
        end for
        DrawWrapped(t, 220, y + 30, 840, ui.dim, "tiny", 3)
    end if
    UiRound(490, 588, 300, 54, ui.rowHi)
    DrawTextC("OK   Continue", 640, 600, ui.ink, "bodyb")
end sub

' ---------------------------------------------------------------- controls (from the pause menu)
sub ControlsOverlayDraw()
    UiDim(160)
    UiPanel(140, 110, 1000, 470)
    m.screen.DrawText("Controls", 176, 126, m.ui.text, m.fonts.head)
    ControlsDraw(176, 184)
    UiHints([["Back", "Pause menu"]])
end sub
