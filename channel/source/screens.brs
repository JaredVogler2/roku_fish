' ============================================================================
' screens.brs - the menus outside a run: main menu, mode setup, practice, settings, about.
' The living reef (the attract scene) keeps swimming behind every screen.
' Each screen has Enter (build its state), Input (this frame's key presses) and Draw.
' ============================================================================

sub AppInit()
    m.app = {
        screen: "loading"
        overlay: ""
        st: invalid          ' state of the current screen
        ov: invalid          ' state of the current overlay
        summary: invalid
        quit: false
        test: invalid        ' test hook requested by a launch parameter
        guideReturn: ""
    }
end sub

sub AppGoto(screen as string)
    app = m.app
    app.screen = screen
    app.overlay = ""
    app.ov = invalid
    m.inp.pressed = []
    if screen = "menu" then
        MenuEnter()
    else if screen = "ascension" or screen = "tournament" or screen = "challenge" then
        SetupEnter(screen)
    else if screen = "practice" then
        PracticeEnter()
    else if screen = "settings" then
        SettingsEnter()
    else if screen = "guide" then
        GuideEnter("")
    else if screen = "creator" then
        CreatorEnter()
    else if screen = "about" then
        app.st = { page: 0 }
    end if
end sub

sub AppStartRun(rc as object)
    s = m.save.settings
    if rc.rules = invalid then rc.rules = s.rules
    if rc.difficulty = invalid then rc.difficulty = s.difficulty
    if rc.classicChomp = invalid then rc.classicChomp = s.classicchomp
    m.app.summary = invalid
    m.app.screen = "game"
    m.app.overlay = ""
    m.app.ov = invalid
    m.inp.pressed = []
    HudInit()
    GameStartRun(rc)
end sub

' Leave the run. withSummary shows the run report over the main menu.
sub AppQuitToMenu(withSummary as boolean, victory as boolean)
    if withSummary then m.app.summary = SummaryBuild(victory)
    GameEndRun()
    AppGoto("menu")
    if withSummary and m.app.summary <> invalid then m.app.overlay = "summary"
end sub

' ---------------------------------------------------------------- main menu
sub MenuEnter()
    sv = m.save
    rows = []
    rows.Push({ kind: "button", id: "ascension", label: "Play - Reef Ascension", note: "Grow from hatchling to apex hunter", primary: true, help: "You hatch as a tiny Lumen Wrasse. Every meal adds biomass: grow through ten milestones, unlock new prey and body upgrades, and try to become the apex of the reef." })
    if sv.ascension <> invalid then
        cp = sv.ascension
        rows.Push({ kind: "button", id: "continue", label: "Continue Ascension", note: "Checkpoint: " + m.bal.growth.milestonenames[cp.milestone] + " - " + FmtInt(cp.score) + " pts", help: "Pick up your last growth checkpoint." })
    end if
    tnote = "The species ladder: Silver Sprat to Great White Shark. Score points to move up; each stage changes your species."
    if sv.tournament <> invalid then
        lad = m.cfgData.tournamentladder
        si = sv.tournament.stage
        if si > lad.Count() - 1 then si = lad.Count() - 1
        tnote = tnote + " You are on stage " + (si + 1).ToStr() + ": " + GetSpecies(lad[si]).name + "."
    end if
    rows.Push({ kind: "button", id: "tournament", label: "Classic Tournament", help: tnote })
    rows.Push({ kind: "button", id: "challenge", label: "Challenge", help: "Four species, rising score targets, one life. About 15 to 25 minutes." })
    rows.Push({ kind: "button", id: "practice", label: "Practice", help: "Swim as any of the 50 playable species, in any region, with your own rules." })
    rows.Push({ kind: "button", id: "creator", label: "Reef Lab - Create a Fish", help: "Design your own fish with a 1,000 point budget, then test it on the reef." })
    rows.Push({ kind: "button", id: "guide", label: "Field Guide", help: sv.discovered.Count().ToStr() + " of " + m.speciesBase.ToStr() + " species discovered. Read what each one eats, what eats it, and how it defends itself." })
    rows.Push({ kind: "button", id: "settings", label: "Settings", help: "Sound, target rings, hints, graphics detail and the default rules." })
    rows.Push({ kind: "button", id: "tutorial", label: "Learn the Reef (tutorial)", help: "A two-minute guided swim: moving, feeding, hiding, cleaning stations and reading the reef." })
    rows.Push({ kind: "button", id: "about", label: "Controls and About", help: "The remote layout, credits and notes on this edition." })
    f = FormNew(rows)
    if not sv.tutorialseen then
        for i = 0 to rows.Count() - 1
            if rows[i].id = "tutorial" then f.sel = i
        end for
    end if
    m.app.st = { form: f, exitAsk: false }
end sub

sub MenuInput()
    st = m.app.st
    if st.exitAsk then
        for each key in m.inp.pressed
            if key = 6 then m.app.quit = true
            if key = 0 then st.exitAsk = false
        end for
        return
    end if
    a = FormInput(st.form)
    if a = "" then return
    if a = "back" then
        st.exitAsk = true
        Sfx("ui_back")
    else if a = "continue" then
        AppStartRun({ mode: "ascension", checkpoint: m.save.ascension })
    else if a = "tutorial" then
        AppStartRun({ mode: "tutorial" })
    else if Left(a, 1) <> "~" then
        AppGoto(a)
    end if
end sub

sub MenuDraw()
    scr = m.screen
    ui = m.ui
    st = m.app.st
    UiDim(96)
    lg = m.spr["ui_logo"]
    if lg <> invalid then
        scr.DrawScaledObject(392, 132, 0.8, 0.8, lg.parts[0].r0)
    else
        DrawTextShadow("REEFBOUND", 64, 70, ui.text, "huge")
    end if
    y = DrawWrapped("Hatch as a tiny reef fish. Feed, hide, get cleaned, and climb a living Great Barrier Reef food web - where diet, venom, shells and night-time hunters matter as much as size.", 76, 232, 620, ui.text, "small")
    x = 76
    x = x + UiTag(x, y + 12, "50 playable species", ui.gold) + 8
    x = x + UiTag(x, y + 12, "3 reef regions, 27 sectors", ui.dim) + 8
    x = x + UiTag(x, y + 12, "Day and night ecosystem", ui.dim) + 8
    ' what the focused entry does
    note = FormNote(st.form)
    if note <> "" then
        h = WrappedHeight(note, 596, "small") + 28
        UiPanel(64, 356, 632, h)
        DrawWrapped(note, 82, 370, 596, ui.dim, "small")
    end if
    DrawWrapped("An original game inspired by the ecology and mechanics of a classic 1994 educational reef simulation. All art, audio and code are original.", 76, 604, 620, ui.faint, "tiny")
    FormDraw(st.form, 760, 56, 456, 600, not st.exitAsk)
    UiHints([["OK", "Select"], ["Back", "Exit"]])
    if st.exitAsk then
        UiDim(150)
        UiPanel(390, 270, 500, 170)
        DrawTextC("Leave REEFBOUND?", 640, 296, ui.text, "head")
        DrawTextC("Your progress is saved.", 640, 344, ui.dim, "small")
        DrawTextC("OK: exit        Back: stay", 640, 390, ui.gold, "smallb")
    end if
end sub

' ---------------------------------------------------------------- shared rule options
function RulesRows() as object
    s = m.save.settings
    rows = []
    d = { kind: "choice", id: "difficulty", label: "Difficulty", values: ["gentle", "standard", "expert"], labels: ["Gentle", "Standard", "Expert"], idx: 1, help: "Gentle: more food, fewer and less persistent predators. Expert: sharper predators, less food and no target rings." }
    r = { kind: "choice", id: "rules", label: "Rules", values: ["balanced", "classicAccuracy"], labels: ["Balanced", "Classic Accuracy"], idx: 0, help: "Balanced: renewable food runs low and repeat nibbles lose point value. Classic Accuracy: unlimited nibbling of plankton and algae and a full heal at cleaners, like the 1994 original." }
    c = { kind: "toggle", id: "chomp", label: "Classic chomp", value: s.classicchomp, help: "Prey you lock on to hesitates for a moment as you lunge, like the 1990s original." }
    for i = 0 to 2
        if d.values[i] = s.difficulty then d.idx = i
    end for
    if s.rules = "classicAccuracy" then r.idx = 1
    rows.Push(d)
    rows.Push(r)
    rows.Push(c)
    return rows
end function

sub RulesStore(f as object)
    s = m.save.settings
    v = FormValue(f, "difficulty")
    if v <> invalid then s.difficulty = v
    v = FormValue(f, "rules")
    if v <> invalid then s.rules = v
    v = FormValue(f, "chomp")
    if v <> invalid then s.classicchomp = v
    SaveWrite()
end sub

' ---------------------------------------------------------------- ascension / tournament / challenge setup
sub SetupEnter(mode as string)
    sv = m.save
    rows = []
    st = { mode: mode, form: invalid, seedMode: "random", seed: "", ladder: [] }
    if mode = "ascension" then
        if not sv.tutorialseen then rows.Push({ kind: "button", id: "tutorial", label: "First time? Play the tutorial", help: "A two-minute guided swim that teaches feeding, hiding and cleaning stations." })
        if sv.ascension <> invalid then
            rows.Push({ kind: "button", id: "continue", label: "Continue from " + Chr(34) + m.bal.growth.milestonenames[sv.ascension.milestone] + Chr(34), primary: true, help: "Resume from your last growth checkpoint with your score and upgrades." })
            rows.Push({ kind: "button", id: "start", label: "New run", help: "Start again as a hatchling. Your checkpoint is replaced at the first milestone." })
        else
            rows.Push({ kind: "button", id: "start", label: "Start", primary: true, help: "Begin as a hatchling Lumen Wrasse in the Shallow Nursery." })
        end if
    else if mode = "tournament" then
        t = sv.tournament
        if t <> invalid then
            if t.stage > 0 then
                lad = m.cfgData.tournamentladder
                si = t.stage
                if si > lad.Count() - 1 then si = lad.Count() - 1
                rows.Push({ kind: "button", id: "continue", label: "Continue at stage " + (si + 1).ToStr() + ": " + GetSpecies(lad[si]).name, primary: true, help: "Resume the ladder from the last stage you cleared." })
            end if
        end if
        rows.Push({ kind: "button", id: "start", label: "Start from Silver Sprat", primary: (rows.Count() = 0), help: "Begin the ladder at stage 1." })
    else
        st.seed = SetupRandomSeed()
        st.ladder = ChallengePick(st.seed)
        rows.Push({ kind: "button", id: "start", label: "Start challenge", primary: true, help: "One life. Earn 5,000, then 10,000, 15,000 and 20,000 more points with each of the four fish." })
        rows.Push({ kind: "choice", id: "seedmode", label: "Line-up", values: ["random", "daily"], labels: ["Random", "Today's daily"], idx: 0, help: "Random: a fresh set of four species. Daily: the same four for everyone today." })
        rows.Push({ kind: "button", id: "reroll", label: "Reroll the four species", help: "Draw a different random line-up." })
    end if
    rows.Push({ kind: "text", label: "RULES FOR THIS RUN" })
    for each r in RulesRows()
        rows.Push(r)
    end for
    st.form = FormNew(rows)
    m.app.st = st
end sub

function SetupRandomSeed() as string
    chars = "abcdefghjkmnpqrstuvwxyz23456789"
    s = ""
    for i = 1 to 6
        s = s + Mid(chars, Rnd(Len(chars)), 1)
    end for
    return s
end function

sub SetupInput()
    st = m.app.st
    f = st.form
    a = FormInput(f)
    if a = "" then return
    if a = "back" then
        Sfx("ui_back")
        AppGoto("menu")
        return
    end if
    if Left(a, 1) = "~" then
        RulesStore(f)
        if a = "~seedmode" then
            st.seedMode = FormValue(f, "seedmode")
            if st.seedMode = "daily" then
                st.seed = GameDailySeed()
            else
                st.seed = SetupRandomSeed()
            end if
            st.ladder = ChallengePick(st.seed)
        end if
        return
    end if
    mode = st.mode
    if a = "tutorial" then
        AppStartRun({ mode: "tutorial" })
    else if a = "reroll" then
        FormSetChoice(f, "seedmode", "random")
        st.seedMode = "random"
        st.seed = SetupRandomSeed()
        st.ladder = ChallengePick(st.seed)
    else if mode = "ascension" then
        if a = "continue" then
            AppStartRun({ mode: "ascension", checkpoint: m.save.ascension })
        else if a = "start" then
            AppStartRun({ mode: "ascension" })
        end if
    else if mode = "tournament" then
        if a = "continue" then
            AppStartRun({ mode: "tournament", tournamentStage: m.save.tournament.stage, tournamentScore: m.save.tournament.score })
        else if a = "start" then
            AppStartRun({ mode: "tournament", tournamentStage: 0, tournamentScore: 0 })
        end if
    else if mode = "challenge" then
        if a = "start" then AppStartRun({ mode: "challenge", challengeSeed: st.seed, seed: "challenge-" + st.seed })
    end if
end sub

sub SetupDraw()
    scr = m.screen
    ui = m.ui
    st = m.app.st
    mode = st.mode
    UiDim(120)
    UiPanel(48, 124, 700, 524)
    if mode = "ascension" then
        UiTitle("Reef Ascension", "Grow from hatchling to apex")
        UiPortrait(GetSpecies("lumenWrasse"), 68, 144, 250, 150)
        y = DrawWrapped("You are a juvenile Lumen Wrasse - an original, stylised reef generalist. Every meal adds biomass and your body grows continuously: twice its length by the " + Chr(34) + "Doubled" + Chr(34) + " milestone, four times at Apex.", 336, 144, 392, ui.text, "small")
        y = 312
        y = DrawWrapped("Each of the ten milestones unlocks new prey and, at four of them, a body upgrade. Larger fish burn more energy and attract bigger hunters.", 68, y, 660, ui.dim, "small")
        names = m.bal.growth.milestonenames
        x = 68
        y = y + 12
        for i = 1 to names.Count() - 1
            t = i.ToStr() + ". " + names[i]
            tw = TextWidth(t, "tiny") + 20
            if x + tw > 728 then
                x = 68
                y = y + 34
            end if
            col = ui.dim
            if m.save.ascension <> invalid then
                if i <= m.save.ascension.milestone then col = ui.gold
            end if
            x = x + UiTag(x, y, t, col) + 6
        end for
        DrawWrapped("Continuous growth is a modern addition - the 1994 reference game changed species instead. Real fish do not grow this fast.", 68, y + 44, 660, ui.faint, "tiny")
    else if mode = "tournament" then
        lad = m.cfgData.tournamentladder
        UiTitle("Classic Tournament", "The species ladder - " + lad.Count().ToStr() + " stages")
        cur = 0
        if m.save.tournament <> invalid then cur = m.save.tournament.stage
        if cur > lad.Count() - 1 then cur = lad.Count() - 1
        DrawWrapped("Score points to advance. Swallowing prey whole is worth 1,000 points and a bite 500; a little survival score ticks up while you are out in the open.", 68, 138, 660, ui.dim, "tiny")
        first = cur - 2
        if first > lad.Count() - 6 then first = lad.Count() - 6
        if first < 0 then first = 0
        y = 196
        for i = first to first + 5
            if i < lad.Count() then
                sp = GetSpecies(lad[i])
                fill = &h0C3250C0
                if i = cur then fill = &h1C6E96E6
                UiRound(68, y, 660, 68, fill)
                DrawTextC((i + 1).ToStr(), 96, y + 20, ui.gold, "bodyb")
                UiPortrait(sp, 126, y + 5, 104, 58, true, false)
                col = ui.text
                if i < cur then col = ui.faint
                scr.DrawText(sp.name, 246, y + 8, col, m.fonts.smallb)
                scr.DrawText("Target " + FmtInt(TournamentTarget(i)) + " pts   " + UiAbilityNames(sp), 246, y + 36, ui.faint, m.fonts.tiny)
                if i = cur and cur > 0 then DrawTextR("checkpoint", 712, y + 22, ui.gold, "tiny")
                y = y + 74
            end if
        end for
    else
        UiTitle("Challenge", "Four species, rising targets, one life")
        DrawWrapped("Earn 5,000 / 10,000 / 15,000 / 20,000 additional points with each fish in turn. There are no checkpoints.", 68, 138, 660, ui.dim, "tiny")
        tg = m.bal.score.challengetargets
        for i = 0 to 3
            if i < st.ladder.Count() then
                sp = GetSpecies(st.ladder[i])
                cx = 68 + (i MOD 2) * 336
                cy = 196 + (i \ 2) * 150
                UiRound(cx, cy, 324, 140, &h0C3250C0)
                UiPortrait(sp, cx + 8, cy + 8, 150, 92, true, false)
                scr.DrawText((i + 1).ToStr() + ".", cx + 168, cy + 12, ui.gold, m.fonts.bodyb)
                DrawWrapped(sp.name, cx + 168, cy + 42, 146, ui.text, "tiny", 2)
                scr.DrawText("Target " + FmtInt(tg[i]), cx + 12, cy + 108, ui.faint, m.fonts.tiny)
            end if
        end for
        ' local best runs
        y = 508
        scr.DrawText("Your best challenge runs", 68, y, ui.text, m.fonts.smallb)
        y = y + 30
        ch = m.save.challenge
        if ch.Count() = 0 then scr.DrawText("No runs yet.", 68, y, ui.faint, m.fonts.tiny)
        n = ch.Count()
        if n > 3 then n = 3
        for i = 0 to n - 1
            e = ch[i]
            t = "ended"
            if e.done = true then t = "completed"
            scr.DrawText(FmtInt(e.score), 68, y, ui.gold, m.fonts.smallb)
            scr.DrawText(t + "   line-up " + e.seed, 200, y + 2, ui.faint, m.fonts.tiny)
            y = y + 28
        end for
    end if
    UiPanel(772, 124, 460, 524)
    FormDraw(st.form, 790, 142, 424, 360)
    note = FormNote(st.form)
    if note <> "" then DrawWrapped(note, 792, 526, 420, ui.dim, "tiny", 5)
    UiHints([["OK", "Select"], ["< >", "Change"], ["Back", "Menu"]])
end sub

' ---------------------------------------------------------------- practice
sub PracticeEnter()
    items = []
    for each c in m.save.custom
        sp = CustomFishSpecies(c)
        items.Push({ sp: sp, known: true, label: sp.name, custom: c })
    end for
    for each sp in m.species
        if sp.playable = true then items.Push({ sp: sp, known: true, label: sp.name })
    end for
    g = GridNew(items, 4, 4)
    rows = []
    rows.Push({ kind: "button", id: "start", label: "Swim", primary: true })
    rows.Push({ kind: "choice", id: "time", label: "Time of day", values: ["cycle", "day", "dusk", "night"], labels: ["Cycle", "Day", "Dusk", "Night"], idx: 0 })
    rows.Push({ kind: "choice", id: "region", label: "Region", values: ["reef", "outer", "wreck"], labels: ["Lagoon Reef", "Outer Wall", "Twilight Wreck"], idx: 0 })
    pv = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    pl = ["None", "25%", "50%", "75%", "100%", "125%", "150%", "175%", "200%"]
    rows.Push({ kind: "choice", id: "pred", label: "Predators", values: pv, labels: pl, idx: 4 })
    rows.Push({ kind: "choice", id: "prey", label: "Prey and food", values: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0], labels: ["25%", "50%", "75%", "100%", "125%", "150%", "175%", "200%"], idx: 3 })
    rows.Push({ kind: "choice", id: "haz", label: "Hazards", values: [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0], labels: ["None", "50%", "100%", "150%", "200%", "250%", "300%"], idx: 2 })
    rows.Push({ kind: "toggle", id: "energy", label: "Infinite energy", value: false })
    rows.Push({ kind: "toggle", id: "invuln", label: "Invulnerable", value: false })
    m.app.st = { grid: g, form: FormNew(rows), focus: "grid", pick: 0 }
    PracticePick(m.app.st)
end sub

sub PracticePick(st as object)
    for each it in st.grid.items
        it.picked = false
    end for
    if st.grid.items.Count() > 0 then st.grid.items[st.pick].picked = true
end sub

sub PracticeInput()
    st = m.app.st
    if st.focus = "grid" then
        a = GridInput(st.grid)
        if a = "ok" then
            st.pick = st.grid.sel
            PracticePick(st)
            st.focus = "form"
            st.form.sel = 0
        else if a = "right" then
            st.focus = "form"
            Sfx("ui_move")
        else if a = "back" then
            Sfx("ui_back")
            AppGoto("menu")
        end if
        return
    end if
    for each key in m.inp.pressed
        if key = 4 then
            r = st.form.rows[st.form.sel]
            if r.kind = "button" then
                st.focus = "grid"
                Sfx("ui_move")
                return
            end if
        end if
    end for
    a = FormInput(st.form)
    if a = "back" then
        st.focus = "grid"
        Sfx("ui_back")
    else if a = "start" then
        f = st.form
        it = st.grid.items[st.pick]
        po = { timeOfDay: FormValue(f, "time"), region: FormValue(f, "region"), predators: FormValue(f, "pred"), prey: FormValue(f, "prey"), hazards: FormValue(f, "haz"), infiniteEnergy: FormValue(f, "energy"), invulnerable: FormValue(f, "invuln") }
        rc = { mode: "practice", practice: po }
        if it.custom <> invalid then
            rc.customFish = it.custom
        else
            rc.speciesId = it.sp.id
        end if
        AppStartRun(rc)
    end if
end sub

sub PracticeDraw()
    scr = m.screen
    ui = m.ui
    st = m.app.st
    UiDim(120)
    UiTitle("Practice", "Any species, your rules")
    UiPanel(48, 124, 716, 524)
    GridDrawSpecies(st.grid, 64, 140, 162, 114, st.focus = "grid")
    UiPanel(784, 124, 448, 524)
    it = st.grid.items[st.grid.sel]
    if st.focus = "form" then it = st.grid.items[st.pick]
    sp = it.sp
    UiPortrait(sp, 800, 138, 150, 88)
    scr.DrawText(FitText(sp.name, "smallb", 262), 962, 140, ui.text, m.fonts.smallb)
    DrawWrapped(UiAbilityNames(sp), 962, 166, 262, ui.gold, "tiny", 1)
    DrawWrapped(UiActivity(sp.activity) + ". Eats: " + UiDietNames(sp), 962, 190, 262, ui.faint, "tiny", 2)
    st.form.rows[0].label = "Swim as " + FitText(sp.name, "bodyb", 300)
    FormDraw(st.form, 800, 244, 416, 400, st.focus = "form")
    UiHints([["OK", "Choose"], ["< >", "Change"], ["Back", "Back"]])
end sub

' ---------------------------------------------------------------- settings
sub SettingsEnter()
    s = m.save.settings
    rows = []
    rows.Push({ kind: "toggle", id: "music", label: "Music", value: s.music, help: "Ambient music loops (a brighter one for the reef, a darker one for the wreck and night)." })
    rows.Push({ kind: "toggle", id: "sfx", label: "Sound effects", value: s.sfx, help: "Bites, warnings, abilities and menu sounds." })
    rows.Push({ kind: "toggle", id: "halos", label: "Target rings", value: s.halos, help: "Rings on nearby creatures: green edible, amber risky, red dangerous. Expert difficulty hides them." })
    rows.Push({ kind: "toggle", id: "hints", label: "Hints", value: s.hints, help: "The controls reminder at the start of a run." })
    rows.Push({ kind: "toggle", id: "shake", label: "Screen shake", value: s.shake, help: "A small camera kick on bites and hits." })
    d = { kind: "choice", id: "detail", label: "Graphics detail", values: ["auto", "high", "low"], labels: ["Auto", "High", "Low"], idx: 0, help: "Low draws less scenery decoration and fewer particles for slower players. Auto chooses for this device. Takes effect immediately." }
    for i = 0 to 2
        if d.values[i] = s.detail then d.idx = i
    end for
    rows.Push(d)
    rows.Push({ kind: "text", label: "DEFAULT RULES" })
    for each r in RulesRows()
        rows.Push(r)
    end for
    rows.Push({ kind: "text", label: "SAVED DATA" })
    rows.Push({ kind: "button", id: "reset", label: "Erase all progress", help: "Deletes checkpoints, discoveries, scores and Reef Lab designs on this device." })
    if m.app.screen = "settings" then
        m.app.st = { form: FormNew(rows), confirm: false }
    else
        m.app.ov = { form: FormNew(rows), confirm: false }
    end if
end sub

sub SettingsStore(f as object)
    s = m.save.settings
    s.music = FormValue(f, "music")
    s.sfx = FormValue(f, "sfx")
    s.halos = FormValue(f, "halos")
    s.hints = FormValue(f, "hints")
    s.shake = FormValue(f, "shake")
    s.detail = FormValue(f, "detail")
    RulesStore(f)
    AudioApplySettings(s.sfx, s.music)
    GfxApplyDetail()
    w = m.game.w
    if w <> invalid and s.music then GameMusicFor(w)
end sub

' Shared by the settings screen and the in-game settings overlay. Returns true when it closes.
function SettingsInput(st as object, allowReset as boolean) as boolean
    if st.confirm then
        for each key in m.inp.pressed
            if key = 6 then
                SaveReset()
                AudioApplySettings(m.save.settings.sfx, m.save.settings.music)
                Sfx("ui_select")
                st.confirm = false
                return true
            else if key = 0 then
                st.confirm = false
            end if
        end for
        return false
    end if
    a = FormInput(st.form)
    if a = "back" then
        Sfx("ui_back")
        return true
    else if a = "reset" then
        if allowReset then st.confirm = true
    else if Left(a, 1) = "~" then
        SettingsStore(st.form)
    end if
    return false
end function

sub SettingsDraw(st as object, title as string)
    ui = m.ui
    UiDim(140)
    UiTitle(title)
    UiPanel(48, 124, 620, 524)
    FormDraw(st.form, 66, 142, 584, 490, not st.confirm)
    UiPanel(692, 124, 540, 524)
    note = FormNote(st.form)
    if note <> "" then DrawWrapped(note, 716, 148, 492, ui.text, "small")
    sv = m.save
    y = 430
    m.screen.DrawText("Your reef so far", 716, y, ui.aqua, m.fonts.smallb)
    y = y + 34
    lines = [
        "Species discovered: " + sv.discovered.Count().ToStr() + " of " + m.speciesBase.ToStr()
        "Runs: " + sv.totals.runs.ToStr() + "    Meals: " + sv.totals.eaten.ToStr() + "    Deaths: " + sv.totals.deaths.ToStr()
        "Best Ascension score: " + FmtInt(sv.best.score) + "    Longest life: " + UiTime(sv.best.longest)
        "Highest Tournament stage: " + (sv.best.stage + 1).ToStr()
    ]
    for each ln in lines
        m.screen.DrawText(ln, 716, y, ui.dim, m.fonts.tiny)
        y = y + 26
    end for
    UiHints([["OK", "Change"], ["< >", "Change"], ["Back", "Done"]])
    if st.confirm then
        UiDim(150)
        UiPanel(340, 260, 600, 190)
        DrawTextC("Erase all progress?", 640, 284, ui.text, "head")
        DrawTextC("Checkpoints, discoveries, scores and designs will be deleted.", 640, 334, ui.dim, "tiny")
        DrawTextC("OK: erase everything        Back: keep it", 640, 392, ui.gold, "smallb")
    end if
end sub

' ---------------------------------------------------------------- controls and about
sub ControlsDraw(x as integer, y as integer)
    scr = m.screen
    ui = m.ui
    rows = [
        ["D-pad", "Swim. Hold a direction; your fish turns and accelerates smoothly."]
        ["OK", "Bite. Locks on to the best prey ahead, chases it and lunges when in reach."]
        ["<<  Rewind", "Use your ability (ink, spines, pulse, burst ...)."]
        [">>  Fast-fwd", "Hold to sprint. Costs energy."]
        ["*  Options", "Second ability, when you have one."]
        ["Replay", "Inspect: step through nearby creatures to see what they are."]
        ["Play/Pause", "Pause menu: Field Guide, reef map, settings."]
        ["Back", "Pause menu. In menus: go back."]
    ]
    for each r in rows
        kw = TextWidth(r[0], "tiny") + 20
        UiRound(x, y, 170, 30, &hEAF8FFE8)
        DrawTextC(r[0], x + 85, y + 5, ui.ink, "tiny")
        scr.DrawText(r[1], x + 186, y + 3, ui.text, m.fonts.tiny)
        y = y + 38
    end for
end sub

sub AboutInput()
    for each key in m.inp.pressed
        if key = 0 or key = 6 then
            Sfx("ui_back")
            AppGoto("menu")
            return
        else if key = 4 or key = 5 then
            m.app.st.page = 1 - m.app.st.page
            Sfx("ui_move")
        end if
    end for
end sub

sub AboutDraw()
    ui = m.ui
    st = m.app.st
    UiDim(140)
    UiPanel(48, 124, 1184, 524)
    if st.page = 0 then
        UiTitle("Controls", "Roku remote")
        ControlsDraw(84, 150)
        DrawWrapped("Rings: green - you can eat it.  Amber - risky (spines, toxins).  Red - dangerous to you.  Grey - not food.  Pulsing red - it is hunting you.", 84, 470, 1100, ui.dim, "tiny")
        DrawWrapped("Hide in seagrass, coral and caves that fit your body. Visit a cleaning station (green cross on the map) to heal. Many animals are only active by day or by night.", 84, 520, 1100, ui.dim, "tiny")
    else
        UiTitle("About", "REEFBOUND: The Living Reef - Roku edition")
        y = DrawWrapped("REEFBOUND is an original underwater survival and food-web game set on a stylised Great Barrier Reef: 77 creatures, 50 of them playable, each with its own diet, defences, activity cycle and place in the web.", 84, 150, 1100, ui.text, "small")
        y = DrawWrapped("It is inspired by the ecology and mechanics of a classic 1994 educational reef simulation. All art, audio and code are original. The animals are simplified for play: sizes, speeds and growth are compressed, and the Lumen Wrasse is a fictional species.", 84, y + 14, 1100, ui.dim, "small")
        y = DrawWrapped("This Roku edition plays the same rules, modes and reef as the web game. Its sprites and scenery were rendered offline for the TV screen, its sound was synthesised for it, and the simulation runs at a fixed 30 ticks per second.", 84, y + 14, 1100, ui.dim, "small")
        y = DrawWrapped("Differences from the web game: steering is by D-pad with an OK-to-chase lock instead of a mouse; Reef Lab fish borrow the look of an existing species; photo mode and key rebinding are not included.", 84, y + 14, 1100, ui.faint, "small")
    end if
    UiHints([["< >", "Controls / About"], ["Back", "Menu"]])
end sub
