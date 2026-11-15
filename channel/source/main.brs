' ============================================================================
' REEFBOUND: The Living Reef - Roku channel entry point.
' ============================================================================

sub Main(args as dynamic)
    GfxInit()
    InputInit()
    FeedInit()
    CameraInit()
    GameInit()
    if not DataLoad() then
        print "FATAL: game data missing"
        return
    end if
    SaveLoad()
    AudioInit()
    GfxProbe()
    if GfxLoadAtlasMeta() then
        while not GfxLoadNextAtlas()
        end while
        GfxBuildSprites()
    end if
    RenderInit()
    rc = { mode: "ascension", rules: "balanced", difficulty: "standard", classicChomp: false }
    GameStartRun(rc)
    m.prof = { ts: CreateObject("roTimespan"), t0: 0, back: 0, scene: 0, crea: 0, front: 0, post: 0, frames: 0, swap: 0, step: 0 }
    last = NowMs()
    frames = 0
    statAt = last
    while true
        InputPoll()
        now = NowMs()
        dt = (now - last) / 1000.0
        last = now
        if dt > 0.25 then dt = 0.25
        if dt < 0 then dt = 0.0
        inp = m.inp
        w = m.game.w
        for each k in inp.pressed
            if k = 0 then return
            if k = 6 then w.inp.attack = true
            if k = 8 then w.inp.ability = true
            if k = 10 then w.inp.ability2 = true
            if k = 7 then w.inp.inspect = true
        end for
        pt = m.prof.ts.TotalMilliseconds()
        GameStep(dt, true)
        m.prof.step = m.prof.step + m.prof.ts.TotalMilliseconds() - pt
        RenderWorld(w, dt, m.game.alpha, false)
        p = w.player
        if p <> invalid then
            DrawTextShadow("HP " + Int(p.health).ToStr() + "  EN " + Int(p.energy).ToStr() + "  act " + w.act.Count().ToStr() + "  sim " + Fmt1(m.game.simMs) + "ms", 20, 20, &hFFFFFFFF, "body")
            DrawTextShadow(w.ps.feedback, 20, 50, &hFFE58AFF, "small")
        end if
        pt = m.prof.ts.TotalMilliseconds()
        m.screen.SwapBuffers()
        m.prof.swap = m.prof.swap + m.prof.ts.TotalMilliseconds() - pt
        frames = frames + 1
        if now - statAt > 2000 then
            print "fps="; frames * 1000 / (now - statAt); " act="; w.act.Count(); " creatures="; w.rr.creatures.Count(); " simMs="; m.game.simMs; " thinks="; w.diagThinks
            pf = m.prof
            if pf.frames > 0 then print "  prof ms/frame: step="; pf.step / pf.frames; " back="; pf.back / pf.frames; " scene="; pf.scene / pf.frames; " crea="; pf.crea / pf.frames; " front="; pf.front / pf.frames; " post="; pf.post / pf.frames; " swap="; pf.swap / pf.frames
            pf.back = 0: pf.scene = 0: pf.crea = 0: pf.front = 0: pf.post = 0: pf.frames = 0: pf.swap = 0: pf.step = 0
            frames = 0
            statAt = now
        end if
    end while
end sub
