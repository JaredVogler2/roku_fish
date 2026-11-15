' ============================================================================
' game.brs - runs: starting and ending them, the fixed-step frame, and turning simulation events
' into sound, effects, toasts and saved progress. Ported from the web game's game.ts.
' ============================================================================

sub GameInit()
    m.game = {
        w: invalid
        rc: invalid            ' the configuration of the current run (invalid = attract scene)
        acc: 0.0
        alpha: 1.0
        toasts: []
        floats: []
        stageCleared: invalid
        deathAt: -1.0
        lastCheckpoint: invalid
        dangerSmooth: 0.0
        recorded: false
        fps: 60.0
        frameMs: 16.0
        simMs: 0.0
        growthSfxAt: 0
    }
end sub

function GameSeed() as string
    dt = CreateObject("roDateTime")
    return "run-" + dt.AsSeconds().ToStr() + "-" + Rnd(9999).ToStr()
end function

function GameDailySeed() as string
    dt = CreateObject("roDateTime")
    return "daily-" + dt.GetYear().ToStr() + "-" + dt.GetMonth().ToStr() + "-" + dt.GetDayOfMonth().ToStr()
end function

function WorldCfg(mode as string, seed as string) as object
    return {
        mode: mode
        seed: seed
        rules: "balanced"
        difficulty: "standard"
        regionId: "reef"
        playerSpecies: ""
        startSector: 0
        startLx: 12.0
        startLy: 6.0
        dayLen: 720.0
        startDay: 0.36
        timeLocked: false
        classicChomp: false
        infiniteEnergy: false
        invulnerable: false
        predatorMul: 1.0
        preyMul: 1.0
        hazardMul: 1.0
        unlocked: { reef: true }
        growthMode: false
        tutorial: false
        noPopulation: false
    }
end function

' The living reef behind the menus (no player).
sub GameStartAttract()
    g = m.game
    cfg = WorldCfg("attract", "menu")
    cfg.dayLen = 600.0
    cfg.startDay = 0.42
    w = WorldNew(cfg, SaveKnownSet())
    w.mode = ModeNew("attract")
    g.w = w
    g.rc = invalid
    g.acc = 0.0
    g.stageCleared = invalid
    g.deathAt = -1.0
    g.toasts = []
    g.floats = []
    RenderSetRegion("reef")
    m.cam.sector = -1
    m.cam.viewH = 11.5
    CameraUpdate(w, 0.016, 1.0)
    WorldPrime(w)
    MusicPlay("reef")
end sub

' Wake everything near the camera right away (normally the bubble fills over a few ticks).
sub WorldPrime(w as object)
    rr = w.rr
    passes = rr.creatures.Count() \ 24 + 2
    w.scanAt = 0
    for i = 1 to passes
        WorldScan(w, rr)
    end for
end sub

' rc: { mode, speciesId, seed, rules, difficulty, classicChomp, practice: {...}, tournamentStage,
'        tournamentScore, challengeSeed, checkpoint, customFish }
sub GameStartRun(rc as object)
    g = m.game
    g.rc = rc
    g.recorded = false
    g.stageCleared = invalid
    g.deathAt = -1.0
    g.toasts = []
    g.floats = []
    g.acc = 0.0
    mode = rc.mode
    seed = rc.seed
    if seed = invalid or seed = "" then seed = GameSeed()
    cfg = WorldCfg(mode, seed)
    cfg.rules = rc.rules
    cfg.difficulty = rc.difficulty
    cfg.classicChomp = rc.classicChomp
    for each r in m.save.unlocked
        cfg.unlocked[r] = true
    end for
    species = "lumenWrasse"
    if rc.speciesId <> invalid then species = rc.speciesId
    if rc.customFish <> invalid then
        sp = CustomFishSpecies(rc.customFish)
        m.speciesById[sp.id] = sp
        species = sp.id
    end if
    md = invalid
    lx = 4.0
    ly = 6.2
    if mode = "ascension" or mode = "tutorial" then
        md = ModeNew(mode)
        species = "lumenWrasse"
        cfg.growthMode = true
        cfg.tutorial = (mode = "tutorial")
        if rc.checkpoint <> invalid then
            cfg.regionId = rc.checkpoint.region
            cfg.startDay = rc.checkpoint.daytime
        end if
    else if mode = "tournament" then
        md = ModeNew("tournament")
        if rc.tournamentStage <> invalid then md.stage = rc.tournamentStage
        species = LadderCurrentSpecies(md)
        cfg.dayLen = 900.0
        cfg.startDay = 0.33
    else if mode = "challenge" then
        md = ModeNew("challenge")
        cs = seed
        if rc.challengeSeed <> invalid then cs = rc.challengeSeed
        md.seed = cs
        md.ladder = ChallengePick(cs)
        species = LadderCurrentSpecies(md)
        cfg.dayLen = 900.0
        cfg.startDay = 0.4
    else
        md = ModeNew("practice")
        po = rc.practice
        if po <> invalid then
            cfg.regionId = po.region
            if po.timeOfDay <> "cycle" then
                cfg.timeLocked = true
                cfg.startDay = 0.95
                if po.timeOfDay = "day" then
                    cfg.startDay = 0.45
                else if po.timeOfDay = "dusk" then
                    cfg.startDay = 0.75
                end if
            end if
            cfg.infiniteEnergy = po.infiniteEnergy
            cfg.invulnerable = po.invulnerable
            cfg.predatorMul = po.predators
            cfg.preyMul = po.prey
            cfg.hazardMul = po.hazards
        end if
        cfg.unlocked = { reef: true, outer: true, wreck: true }
    end if
    sp = GetSpecies(species)
    if sp = invalid then sp = GetSpecies("silverSprat")
    ' start in a row the species can live in
    row = 2
    if ArrayHas(sp.rows, 0) then
        row = 0
    else if ArrayHas(sp.rows, 1) then
        row = 1
    end if
    col = 1
    if mode = "ascension" or mode = "tutorial" then col = 0
    if row <> 0 then
        lx = 8.0
        ly = 6.5
    end if
    if sp.band = "floor" and row = 2 then
        lx = 10.0
        ly = 3.0
    end if
    cfg.playerSpecies = sp.id
    cfg.startSector = row * 3 + col
    cfg.startLx = lx
    cfg.startLy = ly
    w = WorldNew(cfg, SaveKnownSet())
    w.mode = md
    g.w = w
    if cfg.growthMode and rc.checkpoint <> invalid then
        cp = rc.checkpoint
        ps = w.ps
        ps.mass = cp.mass
        ps.milestone = cp.milestone
        ps.score = cp.score
        WorldApplyGrowth(w, true)
        for each u in cp.upgrades
            GameApplyUpgrade(u, true)
        end for
        for each um in m.cfgData.upgrademilestones
            if um <= cp.milestone then md.offered[um.ToStr()] = true
        end for
        g.lastCheckpoint = cp
    else
        g.lastCheckpoint = invalid
    end if
    if mode = "tournament" and rc.tournamentScore <> invalid then w.ps.score = rc.tournamentScore
    ModeInit(w)
    RenderSetRegion(w.rr.id)
    p = w.player
    m.cam.danger = 0.0
    CameraSnap(p.x, p.y, p.sector, CameraDesiredViewH(w))
    w.focusX = m.cam.x
    w.focusY = m.cam.y
    w.halfW = m.cam.halfW
    w.halfH = m.cam.halfH
    WorldPrime(w)
    w.events = []
    m.save.totals.runs = m.save.totals.runs + 1
    GameMusicFor(w)
    Sfx("splash")
    InputClearHeld()
end sub

sub GameMusicFor(w as object)
    track = "reef"
    if w.rr.id = "wreck" or w.dl < 0.35 then track = "deep"
    MusicPlay(track)
end sub

sub GameEndRun()
    GameSaveProgress()
    GameStartAttract()
end sub

' Become another species in place (ladder modes, practice respawn).
sub GameRespawnAs(speciesId as string)
    w = m.game.w
    old = w.player
    sp = GetSpecies(speciesId)
    if sp = invalid then return
    row = sp.rows[0]
    col = 1
    lx = 12.0
    ly = 6.5
    if old <> invalid then
        orow = old.sector \ 3
        col = old.sector MOD 3
        if ArrayHas(sp.rows, orow) then
            row = orow
            lx = old.x - col * 24.0
            ly = old.y - (2 - row) * 13.5
        end if
    end if
    w.ps.mass = 1.0
    w.ps.milestone = 0
    p = WorldSpawnPlayer(w, sp, row * 3 + col, lx, ly)
    CameraSnap(p.x, p.y, p.sector, CameraDesiredViewH(w))
    m.game.deathAt = -1.0
    w.actDirty = true
end sub

sub GameAdvanceStage()
    g = m.game
    w = g.w
    nxt = LadderAdvance(w)
    g.stageCleared = invalid
    if nxt = "" then return
    if w.mode.id = "tournament" then
        m.save.tournament = { stage: w.mode.stage, score: w.ps.score }
        if w.mode.stage > m.save.best.stage then m.save.best.stage = w.mode.stage
        SaveWrite()
    end if
    GameRespawnAs(nxt)
end sub

sub GameDeathChoice(opt as string)
    g = m.game
    w = g.w
    rc = g.rc
    if opt = "restartStage" then
        sp = LadderRestartStage(w)
        w.ps.newlyDiscovered = []
        GameRespawnAs(sp)
    else if opt = "respawn" then
        GameRespawnAs(w.player.sp.id)
    else if opt = "continueCheckpoint" then
        rc.mode = "ascension"
        rc.checkpoint = g.lastCheckpoint
        GameStartRun(rc)
    else if opt = "restartRun" then
        rc.checkpoint = invalid
        rc.tournamentStage = 0
        rc.tournamentScore = 0
        if rc.mode = "tournament" then m.save.tournament = invalid
        GameStartRun(rc)
    else
        GameEndRun()
    end if
end sub

' Keep the best challenge runs (once per run).
sub GameRecordChallenge(done as boolean)
    g = m.game
    if g.recorded then return
    g.recorded = true
    w = g.w
    seed = w.mode.seed
    if seed = invalid then seed = ""
    list = m.save.challenge
    list.Push({ score: w.ps.score, seed: seed, done: done })
    ' highest first, top eight
    n = list.Count()
    for i = 1 to n - 1
        j = i
        while j > 0
            if list[j - 1].score >= list[j].score then exit while
            t = list[j - 1]
            list[j - 1] = list[j]
            list[j] = t
            j = j - 1
        end while
    end for
    while list.Count() > 8
        list.Pop()
    end while
    SaveWrite()
end sub

sub GameSaveCheckpoint()
    g = m.game
    w = g.w
    p = w.player
    if p = invalid then return
    if not p.alive then return
    if not w.cfg.growthMode then return
    ups = []
    for each u in w.ps.upgrades
        ups.Push(u)
    end for
    cp = { mass: w.ps.mass, milestone: w.ps.milestone, upgrades: ups, score: w.ps.score, daytime: w.dayTime, region: w.rr.id }
    g.lastCheckpoint = cp
    m.save.ascension = cp
    GameSaveProgress()
end sub

' Records, discoveries and unlocked regions (written at checkpoints, deaths and when leaving a run).
sub GameSaveProgress()
    g = m.game
    w = g.w
    if w = invalid then return
    if g.rc = invalid then return
    ps = w.ps
    best = m.save.best
    if w.cfg.growthMode then
        if ps.maxLength > best.length then best.length = ps.maxLength
        if ps.score > best.score then best.score = ps.score
    end if
    if ps.timeAlive > best.longest then best.longest = Int(ps.timeAlive)
    unl = []
    for each r in ["reef", "outer", "wreck"]
        if ArrayHas(m.save.unlocked, r) then
            unl.Push(r)
        else if w.cfg.unlocked.DoesExist(r) and w.cfg.mode <> "practice" and w.cfg.mode <> "creatorTest" then
            unl.Push(r)
        end if
    end for
    m.save.unlocked = unl
    SaveWrite()
end sub

sub GameApplyUpgrade(id as string, silent as boolean)
    w = m.game.w
    p = w.player
    if p = invalid then return
    def = invalid
    for each u in m.upgrades
        if u.id = id then def = u
    end for
    if def = invalid then return
    if def.mul <> invalid then
        for each k in def.mul
            v = def.mul[k]
            if k = "burst" then p.mBurst = p.mBurst * v
            if k = "sprintdrain" then p.mSprintDrain = p.mSprintDrain * v
            if k = "damagetaken" then p.mDamage = p.mDamage * v
            if k = "perception" then p.mPerception = p.mPerception * v
            if k = "drain" then p.mDrain = p.mDrain * v
            if k = "lungecooldown" then p.mLungeCd = p.mLungeCd * v
            if k = "speed" then p.mSpeed = p.mSpeed * v
            if k = "agility" then p.mAgility = p.mAgility * v
        end for
    end if
    if def.add <> invalid then
        for each k in def.add
            v = def.add[k]
            if k = "armor" then p.mArmor = p.mArmor + v
            if k = "bitestrength" then p.mBite = p.mBite + v
            if k = "venomres" then p.mVenomRes = p.mVenomRes + v
            if k = "spines" then p.mSpines = p.mSpines + v
        end for
    end if
    if def.grant <> invalid then
        if w.ps.primary = "none" then
            w.ps.primary = def.grant
        else
            w.ps.secondary = def.grant
        end if
    end if
    if not ArrayHas(w.ps.upgrades, id) then w.ps.upgrades.Push(id)
    w.ps.pendingUpgrade = invalid
    w.playerVersion = w.playerVersion + 1
    if not silent then
        Sfx("upgrade")
        GameSaveCheckpoint()
    end if
end sub

sub GameToast(text as string, kind = "info" as string)
    g = m.game
    ' the same message is not stacked twice
    for each t in g.toasts
        if t.text = text then
            t.until = NowMs() + 3600
            return
        end if
    end for
    g.toasts.Push({ text: text, until: NowMs() + 3600, kind: kind })
    if g.toasts.Count() > 3 then g.toasts.Delete(0)
end sub

sub GameFloat(text as string, x as float, y as float, color as integer)
    g = m.game
    if g.floats.Count() > 6 then g.floats.Delete(0)
    g.floats.Push({ text: text, x: x, y: y, t0: NowMs(), color: color })
end sub

' Volume for a sound at a reef position: full on screen, fading with distance from the camera.
function GameGainAt(x as float, y as float, base as float) as float
    cam = m.cam
    d = Dist(cam.x, cam.y, x, y)
    k = 1 - d / (cam.halfW * 1.6 + 4)
    if k < 0 then k = 0.0
    return base * k
end function

' ---------------------------------------------------------------- events -> presentation
sub GameEvents(w as object)
    evs = w.events
    if evs.Count() = 0 then return
    w.events = []
    g = m.game
    for each e in evs
        ev = e.ev
        if ev = "FOOD_BITE" then
            if e.isPlayer then
                Sfx("bite")
                CameraShake(0.03)
            else
                Sfx("nibble", GameGainAt(e.x, e.y, 0.4))
            end if
        else if ev = "FOOD_CONSUMED" then
            if e.isPlayer then
                Sfx("gulp")
                CameraShake(0.05)
                RenderBubbles(e.x, e.y, 6, 0.3)
                m.save.totals.eaten = m.save.totals.eaten + 1
            else
                Sfx("bite", GameGainAt(e.x, e.y, 0.35))
            end if
        else if ev = "SCORE" then
            GameFloat("+" + FmtInt(e.delta), e.x, e.y, &hFFE58AFF)
        else if ev = "HARMFUL_BITE" then
            if e.isPlayer then Sfx("toxic")
        else if ev = "FEED_REJECTED" then
            if e.isPlayer then
                if e.result = "REPELLED" then
                    Sfx("spines", 0.7)
                else
                    Sfx("blocked", 0.7)
                end if
            end if
        else if ev = "NO_TARGET" then
            Sfx("ui_error", 0.6)
        else if ev = "ATTACK_MISSED" then
            if e.isPlayer then Sfx("miss", 0.6)
        else if ev = "DAMAGE_TAKEN" then
            if e.isPlayer then
                Sfx("hurt")
                CameraShake(0.12)
            end if
        else if ev = "PREDATOR_SPOTTED" then
            Sfx("predator", 0.8)
            c = WorldGet(w, e.predatorId)
            if c <> invalid then
                w.sightings.Push({ sector: c.sector, name: c.sp.name, at: w.time })
                if w.sightings.Count() > 6 then w.sightings.Delete(0)
                if c.length > 3 then CameraShake(0.08)
            end if
        else if ev = "PREDATOR_LOST" then
            Sfx("escape", 0.8)
        else if ev = "CLEANING_STARTED" then
            Sfx("cleaning")
        else if ev = "HEALED" then
            Sfx("heal", 0.5)
        else if ev = "MILESTONE_REACHED" then
            Sfx("milestone")
            GameToast("You grew into a " + e.name + "!", "good")
            if w.player <> invalid then RenderBubbles(w.player.x, w.player.y, 10, 1.2)
        else if ev = "GROWTH" then
            now = NowMs()
            if now - g.growthSfxAt > 900 then
                g.growthSfxAt = now
                Sfx("growth", 0.5)
            end if
        else if ev = "SPECIES_DISCOVERED" then
            SaveDiscover(e.speciesId)
            sp = GetSpecies(e.speciesId)
            if sp <> invalid and w.player <> invalid and g.rc <> invalid then
                if w.time > 1.5 and sp.id <> w.player.sp.id then
                    Sfx("discover", 0.6)
                    GameToast("New in your Field Guide: " + sp.name, "info")
                end if
            end if
        else if ev = "ABILITY_USED" then
            ab = e.ability
            snd = ""
            if ab = "inkCloud" then
                snd = "ink"
            else if ab = "electricPulse" then
                snd = "pulse"
            else if ab = "sonicBurst" then
                snd = "sonic"
            else if ab = "sting" then
                snd = "sting"
            else if ab = "inflate" then
                snd = "inflate"
            else if ab = "defensiveSpines" then
                snd = "spines"
            else if ab = "burstSprint" then
                snd = "sprint"
            else if ab = "lure" then
                snd = "lure"
            else if ab = "cleanerMimic" then
                snd = "mimic"
            else if ab = "camouflage" then
                snd = "camo"
            else if ab = "illuminate" then
                snd = "illuminate"
            end if
            if snd <> "" then
                if e.isPlayer then
                    Sfx(snd)
                    if ab = "burstSprint" then RenderBubbles(e.x, e.y, 5, 0.4)
                else
                    Sfx(snd, GameGainAt(e.x, e.y, 0.6))
                end if
            end if
        else if ev = "STAGE_CLEARED" then
            Sfx("stage")
            g.stageCleared = { stage: e.stage, nxt: e.nextSpecies }
        else if ev = "DIED" then
            if e.isPlayer then
                Sfx("death")
                RenderBubbles(e.x, e.y, 16, 0.8)
                g.deathAt = NowMs()
                m.save.totals.deaths = m.save.totals.deaths + 1
                GameSaveProgress()
            end if
        else if ev = "LOW_ENERGY" then
            Sfx("lowenergy")
        else if ev = "REGION_CHANGED" then
            Sfx("region")
            RenderSetRegion(w.rr.id)
            p = w.player
            CameraSnap(p.x, p.y, p.sector, CameraDesiredViewH(w))
            WorldPrime(w)
            GameToast("Entering the " + RegionName(w.rr.id), "info")
            GameMusicFor(w)
        else if ev = "PASS_LOCKED" then
            Sfx("blocked")
        else if ev = "SECTOR_CHANGED" then
            w.visited[e.dest.ToStr()] = true
        else if ev = "OBJECTIVE_COMPLETE" then
            Sfx("discover", 0.8)
            GameToast("Goal complete: " + e.text + "  +250", "good")
        else if ev = "UPGRADE_OFFERED" then
            Sfx("milestone", 0.6)
        else if ev = "CHECKPOINT" then
            GameSaveCheckpoint()
        else if ev = "REGION_UNLOCKED" then
            GameSaveProgress()
        else if ev = "HINT" then
            GameToast(e.text, "good")
        else if ev = "TUTORIAL_DONE" then
            m.save.tutorialseen = true
            SaveWrite()
        else if ev = "DAYPHASE" then
            GameMusicFor(w)
            if g.rc <> invalid then
                if e.phase = 3 then GameToast("Dusk: night hunters are waking.", "info")
                if e.phase = 1 then GameToast("Dawn: the day shift returns.", "info")
            end if
        else if ev = "SHELTER_ENTERED" then
            Sfx("camo", 0.35)
        end if
    end for
end sub

' ---------------------------------------------------------------- frame
' Advance the simulation by real time dt (fixed 1/30 s ticks, at most three per frame; time left
' over after a stall is discarded, so a hitch never turns into a burst of hunger or damage).
sub GameStep(dt as float, running as boolean)
    g = m.game
    w = g.w
    if running then
        inp = m.inp
        wi = w.inp
        mx = 0.0
        my = 0.0
        if inp.held[4] then mx = mx - 1
        if inp.held[5] then mx = mx + 1
        if inp.held[2] then my = my + 1
        if inp.held[3] then my = my - 1
        wi.moveX = mx
        wi.moveY = my
        wi.sprint = inp.held[9]
        t0 = m.clock.TotalMilliseconds()
        g.acc = g.acc + dt
        steps = 0
        while g.acc >= 0.0333333 and steps < 3
            WorldStep(w)
            g.acc = g.acc - 0.0333333
            steps = steps + 1
        end while
        if steps >= 3 then g.acc = 0.0
        g.alpha = g.acc / 0.0333333
        if steps > 0 then g.simMs = g.simMs * 0.9 + (m.clock.TotalMilliseconds() - t0) / steps * 0.1
    else
        g.alpha = 1.0
        g.acc = 0.0
    end if
    GameEvents(w)
    ' how close is the nearest hunter (pulls the camera back a little)
    danger = 0.0
    p = w.player
    if p <> invalid then
        if p.alive and w.ps.chasedCount > 0 then
            for each key in w.ps.chasedBy
                c = WorldGet(w, key.ToInt())
                if c <> invalid then
                    d = 1 - Dist(c.x, c.y, p.x, p.y) / 14.0
                    if d > danger then danger = d
                end if
            end for
        end if
    end if
    g.dangerSmooth = g.dangerSmooth + (danger - g.dangerSmooth) * MinF(1.0, dt * 2)
    m.cam.danger = g.dangerSmooth
    CameraUpdate(w, dt, g.alpha)
end sub
