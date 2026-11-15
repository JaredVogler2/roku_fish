' ============================================================================
' REEFBOUND: The Living Reef - Roku channel entry point and main loop.
'
' One roScreen, one loop: read the remote, advance the reef in fixed 1/30 s ticks, draw the reef,
' then draw whichever interface is up (HUD, a menu screen or an overlay) and swap buffers.
' ============================================================================

sub Main(args as dynamic)
    GfxInit()
    InputInit()
    UiInit()
    AppInit()
    FeedInit()
    CameraInit()
    GameInit()
    HudInit()
    LoadingDraw(0.04, "Reading the reef charts")
    if not DataLoad() then
        FatalScreen("The game data is missing or damaged. Please reinstall the channel.")
        return
    end if
    SaveLoad()
    AudioInit()
    AudioApplySettings(m.save.settings.sfx, m.save.settings.music)
    GfxProbe()
    if type(args) = "roAssociativeArray" then
        ' (test harness) force a detail level for this launch without saving it
        if args.detail <> invalid then m.save.settings.detail = args.detail
    end if
    GfxDetectDetail()
    if not GfxLoadAtlasMeta() then
        FatalScreen("The artwork is missing or damaged. Please reinstall the channel.")
        return
    end if
    n = m.atlasMeta.atlases.Count()
    i = 0
    LoadingDraw(0.1, "Growing coral")
    while not GfxLoadNextAtlas()
        i = i + 1
        LoadingDraw(0.1 + 0.6 * i / n, "Growing coral")
    end while
    GfxBuildSprites()
    LoadingDraw(0.8, "Releasing fish")
    RenderInit()
    GameStartAttract()
    LoadingDraw(1.0, "Warming the water")
    m.splashBmp = invalid
    AppGoto("menu")
    AppDebugArgs(args)
    AppLoop()
end sub

' The loading screen is the splash picture again (so the hand-over from the system splash is
' seamless) with a progress bar under the wordmark.
sub LoadingDraw(frac as float, msg as string)
    scr = m.screen
    if m.splashTried <> true then
        m.splashTried = true
        m.splashBmp = CreateObject("roBitmap", "pkg:/images/splash_hd.jpg")
    end if
    scr.Clear(&h04162BFF)
    if m.splashBmp <> invalid then
        scr.DrawObject(0, 0, m.splashBmp)
    else
        DrawTextC("REEFBOUND", 640, 250, &hEEF9FFFF, "huge")
        DrawTextC("THE LIVING REEF", 640, 330, &hB4D2E0FF, "small")
    end if
    scr.DrawRect(440, 440, 400, 10, &h0E3552FF)
    scr.DrawRect(440, 440, Int(400 * frac), 10, &h5FE3F0FF)
    DrawTextShadowC(msg + "...", 640, 462, &hD8ECF6FF, "small")
    scr.SwapBuffers()
end sub

sub FatalScreen(msg as string)
    print "FATAL: "; msg
    scr = m.screen
    while true
        scr.Clear(&h04162BFF)
        DrawTextC("REEFBOUND cannot start", 640, 280, &hEEF9FFFF, "head")
        DrawTextC(msg, 640, 340, &hB4D2E0FF, "small")
        DrawTextC("Press Back to exit.", 640, 400, &hFFD86AFF, "small")
        scr.SwapBuffers()
        msgEv = wait(250, m.port)
        if type(msgEv) = "roUniversalControlEvent" then
            if msgEv.GetInt() = 0 then return
        end if
    end while
end sub

' Launch parameters used by the test harness and for deep links, e.g. mode=ascension.
' (A side-loaded or store launch has none of these and lands on the main menu.)
sub AppDebugArgs(args as dynamic)
    if type(args) <> "roAssociativeArray" then return
    if args.test <> invalid then m.app.test = args.test
    md = args.mode
    if md = invalid then md = args.contentId
    if md = invalid then return
    if md = "ascension" or md = "tutorial" then
        AppStartRun({ mode: md })
    else if md = "tournament" then
        AppStartRun({ mode: "tournament", tournamentStage: 0, tournamentScore: 0 })
    else if md = "challenge" then
        AppStartRun({ mode: "challenge", challengeSeed: "daily", seed: "challenge-daily" })
    else if md = "practice" then
        sp = args.species
        if sp = invalid then sp = "coralGrouper"
        po = { timeOfDay: "cycle", region: "reef", predators: 1.0, prey: 1.0, hazards: 1.0, infiniteEnergy: false, invulnerable: false }
        if args.region <> invalid then po.region = args.region
        if args.time <> invalid then po.timeOfDay = args.time
        AppStartRun({ mode: "practice", speciesId: sp, practice: po })
    end if
end sub

sub AppLoop()
    app = m.app
    last = NowMs()
    frames = 0
    slow = 0
    statAt = last
    while not app.quit
        InputPoll()
        now = NowMs()
        dt = (now - last) / 1000.0
        last = now
        if dt > 0.25 then dt = 0.25
        if dt < 0 then dt = 0.0
        m.ui.t = m.ui.t + dt
        if app.screen = "game" then
            GameFrame(dt)
        else
            MenuFrame(dt)
        end if
        m.screen.SwapBuffers()
        frames = frames + 1
        if now - statAt >= 1000 then
            m.game.fps = frames * 1000.0 / (now - statAt)
            frames = 0
            statAt = now
            ' On Auto, a player that cannot hold a playable frame rate sheds decoration by itself
            ' (distant growth, light shafts, half the drifting particles) - never the simulation.
            if m.save.settings.detail = "auto" and not m.lowFx then
                if m.game.fps < 21 then
                    slow = slow + 1
                    if slow >= 6 then
                        m.lowFx = true
                        print "gfx: frame rate is low, switching decoration to low detail"
                    end if
                else
                    slow = 0
                end if
            end if
        end if
    end while
    GameSaveProgress()
    SaveWrite()
end sub

' Test hooks (launch parameter test=...): force situations that are slow to reach by playing.
sub AppTestHook(w as object)
    app = m.app
    t = app.test
    if t = "trace" then
        ' once a second: where the player and the camera are (for chasing camera bugs)
        if w.tick MOD 30 = 0 and w.player <> invalid then
            p = w.player
            cam = m.cam
            print "trace t="; Int(w.time); " p=("; Int(p.x * 10) / 10; ","; Int(p.y * 10) / 10; ") sec="; p.sector; " cam=("; Int(cam.x * 10) / 10; ","; Int(cam.y * 10) / 10; ") camsec="; cam.sector; " scr=("; p.scrX; ","; p.scrY; ") vh="; Int(cam.viewH * 10) / 10; " trans="; cam.trans; " fps="; Int(m.game.fps)
        end if
        return
    end if
    if t = invalid or w.time < 3 then return
    app.test = invalid
    p = w.player
    if p = invalid then return
    if t = "death" then
        WorldDamage(w, p, 9999.0, "eaten", "blacktipShark", false)
    else if t = "starve" then
        p.energy = 0.0
    else if t = "upgrade" or t = "apex" then
        w.ps.mass = 2.6
        if t = "apex" then w.ps.mass = 60.0
        WorldApplyGrowth(w, false)
        ms = MilestoneForMass(w.ps.mass)
        if ms > w.ps.milestone then
            w.ps.milestone = ms
            w.playerVersion = w.playerVersion + 1
            WorldEmit(w, { ev: "MILESTONE_REACHED", milestone: ms, name: m.bal.growth.milestonenames[ms], length: p.length })
        end if
    else if t = "stage" then
        w.ps.score = w.ps.score + 60000
    else if t = "hurt" then
        WorldDamage(w, p, p.health * 0.6, "bitten", "lionfish", false)
    else if t = "night" then
        w.dayTime = 0.93
    end if
end sub

' ---------------------------------------------------------------- a frame while playing
sub GameFrame(dt as float)
    app = m.app
    g = m.game
    w = g.w
    p = w.player
    ps = w.ps
    inp = m.inp
    if app.test <> invalid then AppTestHook(w)

    ' what, if anything, is in front of the game?
    modal = app.overlay
    if modal = "" then
        if ps.pendingUpgrade <> invalid then
            modal = "upgrade"
        else if g.stageCleared <> invalid then
            modal = "stage"
        else if p <> invalid then
            if (not p.alive) and g.deathAt > 0 then
                if NowMs() - g.deathAt > 1500 then
                    DeathOpen()
                    modal = "death"
                end if
            end if
        end if
    end if

    if modal = "" then
        for each k in inp.pressed
            if k = 0 or k = 13 then
                PauseOpen()
                modal = "pause"
            else if k = 6 then
                w.inp.attack = true
            else if k = 8 then
                w.inp.ability = true
            else if k = 10 then
                if w.mode.id = "tutorial" and (not w.mode.done) and (ps.secondary = "" or ps.secondary = "none") then
                    TutorialNext(w)
                else
                    w.inp.ability2 = true
                end if
            else if k = 7 then
                w.inp.inspect = true
            end if
        end for
    else if modal = "pause" then
        PauseInput()
    else if modal = "death" then
        DeathInput()
    else if modal = "upgrade" then
        UpgradeInput()
    else if modal = "stage" then
        StageInput()
    else if modal = "map" or modal = "controls" then
        for each k in inp.pressed
            if k = 0 or k = 6 then
                Sfx("ui_back")
                PauseOpen()
            end if
        end for
    else if modal = "settings" then
        if SettingsInput(app.ov, false) then PauseOpen()
    else if modal = "guide" then
        if GuideInput() then
            if app.guideReturn = "death" then
                app.guideReturn = ""
                DeathOpen()
            else
                PauseOpen()
            end if
        end if
    end if

    ' input may have ended the run
    if app.screen <> "game" then
        MenuFrame(dt)
        return
    end if

    w = m.game.w
    running = (app.overlay = "" and w.ps.pendingUpgrade = invalid and g.stageCleared = invalid)
    GameStep(dt, running)
    w = m.game.w
    RenderWorld(w, dt, g.alpha, not running)
    ov = app.overlay
    ' full-screen overlays replace the HUD; panels (pause, death ...) sit over it
    if not (ov = "map" or ov = "guide" or ov = "settings" or ov = "controls") then HudDraw(w, dt)

    if ov = "pause" then
        PauseDraw()
    else if ov = "death" then
        DeathDraw()
    else if ov = "map" then
        MapDraw()
    else if ov = "controls" then
        ControlsOverlayDraw()
    else if ov = "settings" then
        SettingsDraw(app.ov, "Settings")
    else if ov = "guide" then
        GuideDraw()
    else if w.ps.pendingUpgrade <> invalid then
        UpgradeDraw()
    else if g.stageCleared <> invalid then
        StageDraw()
    end if
end sub

' ---------------------------------------------------------------- a frame in the menus
sub MenuFrame(dt as float)
    app = m.app
    g = m.game
    sc = app.screen
    if app.overlay = "summary" then
        SummaryInput()
    else if sc = "menu" then
        MenuInput()
    else if sc = "ascension" or sc = "tournament" or sc = "challenge" then
        SetupInput()
    else if sc = "practice" then
        PracticeInput()
    else if sc = "settings" then
        if SettingsInput(app.st, true) then AppGoto("menu")
    else if sc = "guide" then
        if GuideInput() then AppGoto("menu")
    else if sc = "creator" then
        CreatorInput()
    else if sc = "about" then
        AboutInput()
    end if

    ' a screen may have started a run
    if app.screen = "game" then
        GameFrame(0.0)
        return
    end if

    GameStep(dt, true)
    RenderWorld(g.w, dt, g.alpha, false)
    if app.test = "clean" then return     ' (test harness) the reef alone, for the splash artwork
    sc = app.screen
    if sc = "menu" then
        MenuDraw()
    else if sc = "ascension" or sc = "tournament" or sc = "challenge" then
        SetupDraw()
    else if sc = "practice" then
        PracticeDraw()
    else if sc = "settings" then
        SettingsDraw(app.st, "Settings")
    else if sc = "guide" then
        GuideDraw()
    else if sc = "creator" then
        CreatorDraw()
    else if sc = "about" then
        AboutDraw()
    end if
    if app.overlay = "summary" then SummaryDraw()
end sub
