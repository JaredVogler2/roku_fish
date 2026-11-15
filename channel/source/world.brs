' ============================================================================
' world.brs - the simulation: one fixed tick of 1/30 s.
'
' Same rules as the web game's World.step, reorganised for a set-top box:
'   * only creatures in a bubble around the camera are fully simulated ("active"); the rest of
'     the region drifts along coarse waypoints a few times a minute and wakes up as you approach
'   * timers are absolute times, so idle creatures cost nothing
'   * AI decisions run a few times a second per creature, staggered; steering and collision run on each creature's own period
' Order per tick: player -> reef passes -> activation -> AI think -> steer / lunge / integrate
' -> abilities -> cleaning -> discovery -> effects -> spawner -> cull -> mode.
' ============================================================================

function TickLen() as float
    return 0.0333333
end function

function WorldNew(cfg as object, known as object) as object
    d = m.cfgData.difficulty[cfg.difficulty]
    w = {
        cfg: cfg
        rng: RngNew(HashStr(cfg.seed + ":world"))
        time: 0.0
        tick: 0
        dayTime: cfg.startDay
        phase: PhaseOf(cfg.startDay)
        regions: {}
        rr: invalid
        byId: [invalid]
        nextId: 1
        player: invalid
        ps: invalid
        inp: InputIntentNew()
        effects: []
        events: []
        mode: invalid
        diff: d
        discovered: {}
        known: known
        regionCooldownUntil: 0.0
        predatorsCalm: false
        spawnGraceUntil: 0.0
        classicChomp: cfg.classicChomp
        act: []
        hunters: []
        movers: []
        actDirty: true
        scanAt: 0
        focusX: 12.0
        focusY: 34.0
        halfW: 12.0
        halfH: 6.8
        abilityUsers: []
        schoolCounter: 1
        lockedNoticeAt: -999.0
        cleanNotified: {}
        diagThinks: 0
        visited: {}
        sightings: []
        playerVersion: 1
        versionLen: 0.0
        dl: Daylight(cfg.startDay)
        inkCount: 0
        actLv: [1.0, 1.0, 1.0, 1.0]
    }
    w.ps = PlayerStateNew()
    if m.dir8 = invalid then m.dir8 = [1.0, 0.0, 0.7071, 0.7071, 0.0, 1.0, -0.7071, 0.7071, -1.0, 0.0, -0.7071, -0.7071, 0.0, -1.0, 0.7071, -0.7071]
    WorldSetPhase(w, w.phase)
    WorldActivateRegion(w, cfg.regionId)
    if cfg.playerSpecies <> "" then
        sp = GetSpecies(cfg.playerSpecies)
        WorldSpawnPlayer(w, sp, cfg.startSector, cfg.startLx, cfg.startLy)
    end if
    return w
end function

function InputIntentNew() as object
    return { moveX: 0.0, moveY: 0.0, sprint: false, ability: false, ability2: false, attack: false, inspect: false }
end function

function PlayerStateNew() as object
    return {
        score: 0
        mass: 1.0
        initialLength: 0.0
        milestone: 0
        upgrades: []
        pendingUpgrade: invalid
        targetId: -1
        primary: "none"
        secondary: ""
        deathCause: ""
        killer: ""
        hidden: false
        lowEnergyWarned: false
        passiveAccum: 0.0
        plantBites: []
        chasedBy: {}
        chasedCount: 0
        chaseBest: 9999.0
        chaseProgressAt: 0.0
        avoidSide: 1
        awayT: 0.0
        feedback: ""
        feedbackAt: -99.0
        preyEaten: 0, bites: 0, swallows: 0, misses: 0, escapes: 0
        timeAlive: 0.0, maxLength: 0.0, maxMass: 0.0, damageTaken: 0.0, healed: 0.0, toxicMistakes: 0, hiddenTime: 0.0
        biggestPredator: "", biggestPredatorLen: 0.0
        newlyDiscovered: []
        inspectId: -1
    }
end function

' Activity level per activity pattern (any, day, night, twilight) for the current phase.
sub WorldSetPhase(w as object, ph as integer)
    w.phase = ph
    w.actLv = [1.0, ActivityLevel(1, ph), ActivityLevel(2, ph), ActivityLevel(3, ph)]
end sub

' ---------------------------------------------------------------- regions
sub WorldActivateRegion(w as object, id as string)
    rr = w.regions[id]
    if rr = invalid then
        rr = RegionLoad(id)
        w.regions[id] = rr
    end if
    if w.rr <> invalid then
        if w.rr.id <> rr.id then w.rr.lastActive = w.time
    end if
    w.rr = rr
    w.act = []
    w.hunters = []
    w.movers = []
    w.actDirty = true
    w.scanAt = 0
    if not rr.populated then
        SpawnerPopulate(w, rr)
        rr.populated = true
    else
        ' Catch-up: replenish what would have respawned while away.
        gap = w.time - rr.lastActive
        if gap > 240 then gap = 240.0
        SpawnerUpdate(w, rr, gap, true)
    end if
    for each c in rr.creatures
        c.active = false
    end for
end sub

function WorldAdd(w as object, sp as object, x as float, y as float, sizeMul as float, rr as object) as object
    if x >= 72 then
        x = x - 72
    else if x < 0 then
        x = x + 72
    end if
    id = w.nextId
    w.nextId = id + 1
    c = CreatureNew(id, sp, x, y, sizeMul)
    c.sector = SectorOf(x, y)
    c.homeSector = c.sector
    r = w.rng
    if RngNext(r) < 0.5 then
        c.hx = -1.0
        c.face = -1.0
        c.faceTo = -1.0
    end if
    c.simAt = w.time
    c.pAt = w.time
    c.hungryAt = w.time + RngRange(r, 0, 12)
    c.nextThink = w.time + RngNext(r) * 0.3
    c.dormAt = w.time
    c.chargeAt = w.time
    c.phase = RngNext(r) * 6.28
    rr.creatures.Push(c)
    w.byId.Push(c)
    return c
end function

function WorldGet(w as object, id as integer) as dynamic
    if id <= 0 then return invalid
    c = w.byId[id]
    if c = invalid then return invalid
    if c.removed then return invalid
    return c
end function

function WorldSpawnPlayer(w as object, sp as object, sector as integer, lx as float, ly as float) as object
    if w.player <> invalid then
        w.player.removed = true
    end if
    col = sector MOD 3
    row = sector \ 3
    x = col * 24.0 + lx
    y = (2 - row) * 13.5 + ly
    id = w.nextId
    w.nextId = id + 1
    p = CreatureNew(id, sp, x, y, 1.0)
    p.isPlayer = true
    rr = w.rr
    ' Find safe water near the requested spot (never inside a wall).
    r = w.rng
    for i = 0 to 39
        if TerrSdf(rr, x, y) >= p.radius + 0.4 then exit for
        x = WrapX(x + RngRange(r, -2, 2))
        y = ClampF(y + RngRange(r, -1, 2), 1.0, 40.0)
    end for
    p.x = x
    p.y = y
    p.px = x
    p.py = y
    p.sector = SectorOf(x, y)
    p.maxHealth = 100.0
    p.health = 100.0
    p.energy = 100.0
    p.active = true
    p.simAt = w.time
    p.pAt = w.time
    rr.creatures.Push(p)
    w.byId.Push(p)
    w.player = p
    ps = w.ps
    ps.primary = sp.ab0
    ps.secondary = sp.ab1
    ps.initialLength = p.length
    p.mDrain = p.mDrain * sp.custom
    if p.length > ps.maxLength then ps.maxLength = p.length
    ps.deathCause = ""
    ps.killer = ""
    ps.targetId = -1
    ps.chasedBy = {}
    ps.chasedCount = 0
    w.spawnGraceUntil = w.time + 6
    if w.cfg.growthMode then WorldApplyGrowth(w, true)
    WorldDiscover(w, sp.id)
    w.focusX = x
    w.focusY = y
    w.actDirty = true
    w.playerVersion = w.playerVersion + 1
    return p
end function

' Ascension growth: length follows the cube root of mass; jaws strengthen with milestones.
sub WorldApplyGrowth(w as object, instant as boolean)
    p = w.player
    if p = invalid then return
    ps = w.ps
    length = p.sp.len * (ps.mass ^ 0.3333333)
    CreatureSetLength(p, length)
    p.mass = ps.mass
    if instant then p.vlen = length
    ms = MilestoneForMass(ps.mass)
    if ms * 0.085 > p.mBite then p.mBite = ms * 0.085
    if length > ps.maxLength then ps.maxLength = length
    if ps.mass > ps.maxMass then ps.maxMass = ps.mass
    ' Other animals re-judge the player only after a noticeable change in size.
    vl = w.versionLen
    if instant or vl <= 0 or length > vl * 1.015 or length < vl * 0.985 then
        w.versionLen = length
        w.playerVersion = w.playerVersion + 1
    end if
end sub

function WorldMilestone(w as object, c as object) as integer
    if c.isPlayer and w.cfg.growthMode then return w.ps.milestone
    return -1
end function

sub WorldDiscover(w as object, speciesId as string)
    if w.discovered.DoesExist(speciesId) then return
    w.discovered[speciesId] = true
    if not w.known.DoesExist(speciesId) then
        w.known[speciesId] = true
        w.ps.newlyDiscovered.Push(speciesId)
        WorldEmit(w, { ev: "SPECIES_DISCOVERED", speciesId: speciesId })
    end if
end sub

' Events are queued for the presentation layer (sound, effects, toasts, saves) and passed to the
' mode controller immediately, as in the web game.
sub WorldEmit(w as object, e as object)
    w.events.Push(e)
    if w.mode <> invalid then ModeOnEvent(w, e)
end sub

sub WorldFeedback(w as object, text as string)
    w.ps.feedback = text
    w.ps.feedbackAt = w.time
end sub

sub WorldAddEffect(w as object, kind as string, x as float, y as float, r as float, dur as float, ownerId as integer)
    w.effects.Push({ kind: kind, x: x, y: y, r: r, t0: w.time, dur: dur, owner: ownerId })
end sub

' ---------------------------------------------------------------- damage / death
sub WorldDamage(w as object, c as object, amount as float, cause as string, sourceSpecies as string, silent as boolean)
    if (not c.alive) or amount <= 0 then return
    if c.isPlayer then
        if w.cfg.invulnerable then return
        if cause = "bitten" and w.time < c.invulnUntil then return
    end if
    c.health = c.health - amount
    if not silent then c.hurtAt = w.time
    c.wound = ClampF(c.wound + amount / c.maxHealth, 0.0, 1.0)
    c.lastDmgSpecies = sourceSpecies
    c.lastDmgCause = cause
    if c.isPlayer then
        w.ps.damageTaken = w.ps.damageTaken + amount
        if cause = "bitten" then c.invulnUntil = w.time + 0.65
    end if
    if not silent then WorldEmit(w, { ev: "DAMAGE_TAKEN", targetId: c.id, isPlayer: c.isPlayer, amount: amount, source: sourceSpecies, cause: cause, x: c.x, y: c.y })
    if c.health <= 0 then
        k = cause
        if cause = "venom" then k = "poisoned"
        WorldKill(w, c, k, sourceSpecies, false)
    end if
end sub

sub WorldKill(w as object, c as object, cause as string, killer as string, remove as boolean)
    if not c.alive then return
    c.alive = false
    if c.health < 0 then c.health = 0.0
    c.diedAt = w.time
    c.vx = c.vx * 0.3
    c.vy = c.vy * 0.3
    if remove then c.removed = true
    if c.isPlayer then
        w.ps.deathCause = cause
        w.ps.killer = killer
    end if
    WorldEmit(w, { ev: "DIED", entityId: c.id, isPlayer: c.isPlayer, speciesId: c.sp.id, cause: cause, killer: killer, x: c.x, y: c.y })
    ' A predator's absence briefly lets small fish flourish.
    if (not c.isPlayer) and c.sp.tier >= 5 then w.rr.bloomUntil[c.homeSector] = w.time + 120
end sub

' ---------------------------------------------------------------- main step
sub WorldStep(w as object)
    dt = 0.0333333
    w.time = w.time + dt
    w.tick = w.tick + 1
    now = w.time
    if not w.cfg.timeLocked then
        dtm = w.dayTime + dt / w.cfg.dayLen
        if dtm >= 1 then dtm = dtm - 1
        w.dayTime = dtm
        ph = PhaseOf(dtm)
        if ph <> w.phase then
            WorldSetPhase(w, ph)
            WorldEmit(w, { ev: "DAYPHASE", phase: ph })
        end if
    end if

    w.dl = Daylight(w.dayTime)
    if w.player <> invalid then
        PlayerUpdate(w, dt)
        TravelCheckPasses(w)
    end if
    rr = w.rr

    WorldScan(w, rr)

    ' Index loops on purpose: on Roku a "for each" keeps its cursor inside the array object, so a
    ' nested for-each over the same array (the AI scans w.act too) would derail the outer one.
    act = w.act
    n = act.Count()

    ' ---- AI think (staggered)
    for i = 0 to n - 1
        c = act[i]
        if c.alive and now >= c.nextThink then
            if not c.isPlayer then
                ' animals near the action decide five times a second, the rest a little less often
                if c.period <= 2 then
                    c.nextThink = now + 0.2
                else
                    c.nextThink = now + 0.3
                end if
                BrainThink(w, c)
            end if
        end if
    end for

    ' ---- steer, lunge, move, collide
    ' The player and anything mid-lunge move every tick. Other swimmers move every second tick
    ' and crawlers every fourth, each with a proportionally longer step; the renderer
    ' interpolates between the last two states, so motion stays smooth at a fraction of the cost.
    p = w.player
    movers = w.movers
    n = movers.Count()
    tick = w.tick
    for i = 0 to n - 1
        c = movers[i]
        if not c.removed then
            due = true
            if not (c.isPlayer or c.lunging) then
                per = c.period
                if per > 1 then
                    if c.sp.mv = 2 or c.sp.mv = 5 or c.surface <> invalid then per = 6
                    due = ((tick + c.id) MOD per = 0)
                end if
            end if
            if due then
                stepT = now - c.simAt
                if stepT > 0.21 then stepT = 0.21
                c.px = c.x
                c.py = c.y
                c.pAt = c.simAt
                c.simAt = now
                if c.alive then
                    if not c.isPlayer then
                        ' steering changes slowly for calm animals: refresh it on alternate updates
                        b = c.behavior
                        if b = 3 or b = 4 or b = 2 or b = 13 then
                            BrainSteer(w, c, stepT)
                        else
                            c.steerFlip = not c.steerFlip
                            if c.steerFlip then BrainSteer(w, c, stepT)
                        end if
                    end if
                    if c.lunging then CombatUpdateLunge(w, c, stepT)
                    BrainIntegrate(w, c, stepT)
                    if c.venom > 0 then
                        dmg = c.venom * 2.2 * 0.4 * stepT
                        c.venom = c.venom - 0.25 * stepT * (1 + c.mVenomRes * 2)
                        if c.venom < 0 then c.venom = 0.0
                        WorldDamage(w, c, dmg, "venom", c.lastDmgSpecies, true)
                    end if
                    if c.health < c.maxHealth and not c.isPlayer then
                        c.health = c.health + stepT * 0.8
                        if c.health > c.maxHealth then c.health = c.maxHealth
                    end if
                else
                    ' dead: sink gently, then disappear
                    k = stepT * 30
                    c.vx = c.vx * (1 - 0.08 * k)
                    c.vy = c.vy * (1 - 0.1 * k) - 0.15 * stepT
                    x = c.x + c.vx * stepT
                    if x >= 72 then
                        x = x - 72
                    else if x < 0 then
                        x = x + 72
                    end if
                    c.x = x
                    c.y = c.y + c.vy * stepT
                    if c.y < 0.3 then c.y = 0.3
                    if (not c.isPlayer) and now - c.diedAt > 2.5 then c.removed = true
                end if
            end if
        end if
    end for
    if p <> invalid then
        s = p.sector
        ns = SectorOf(p.x, p.y)
        if ns <> s then
            p.sector = ns
            WorldEmit(w, { ev: "SECTOR_CHANGED", src: s, dest: ns })
        end if
    end if

    AbilitiesUpdate(w, dt)
    if w.tick MOD 3 = 0 then CleaningUpdate(w, dt * 3)
    if p <> invalid then
        if w.tick MOD 10 = 0 then PlayerDiscovery(w)
    end if

    ' ---- effects expire
    fx = w.effects
    inks = 0
    if fx.Count() > 0 then
        i = fx.Count() - 1
        while i >= 0
            e = fx[i]
            if now - e.t0 >= e.dur then
                fx.Delete(i)
            else if e.kind = "ink" then
                inks = inks + 1
            end if
            i = i - 1
        end while
    end if
    w.inkCount = inks

    if not w.cfg.noPopulation then SpawnerUpdate(w, rr, 0.5, false)

    ' ---- cull removed creatures
    if w.tick MOD 30 = 0 then
        lst = rr.creatures
        keep = []
        any = false
        for each c in lst
            if c.removed then
                w.byId[c.id] = invalid
                any = true
            else
                keep.Push(c)
            end if
        end for
        if any then
            rr.creatures = keep
            w.actDirty = true
            w.scanAt = 0
        end if
    end if

    if w.mode <> invalid then ModeUpdate(w, dt)
    inp = w.inp
    inp.ability = false
    inp.ability2 = false
    inp.attack = false
    inp.inspect = false
end sub

' Rolling pass over the region: wakes creatures entering the bubble around the camera, puts the
' ones leaving it to sleep, and gives sleeping swimmers a coarse move. 24 creatures per tick.
sub WorldScan(w as object, rr as object)
    lst = rr.creatures
    n = lst.Count()
    if n = 0 then return
    fx = w.focusX
    fy = w.focusY
    inX = w.halfW * 1.25 + 2.2
    inY = w.halfH * 1.25 + 1.8
    outX = inX + 2.5
    outY = inY + 2.0
    now = w.time
    i = w.scanAt
    if i >= n then i = 0
    count = 24
    if count > n then count = n
    dirty = w.actDirty
    for k = 1 to count
        c = lst[i]
        if not c.removed then
            dx = c.x - fx
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            if dx < 0 then dx = -dx
            dy = c.y - fy
            if dy < 0 then dy = -dy
            if c.active then
                if (dx > outX or dy > outY) and not c.isPlayer then
                    ' keep hunters that are chasing the player awake a little longer
                    keepAwake = false
                    if c.behavior = 3 and c.targetId > 0 and dx < outX + 6 and dy < outY + 4 then keepAwake = true
                    if not keepAwake then
                        c.active = false
                        c.dormAt = now
                        c.vx = 0.0
                        c.vy = 0.0
                        if c.behavior = 3 or c.behavior = 13 or c.behavior = 4 then
                            BrainForget(w, c)
                        end if
                        dirty = true
                    end if
                end if
            else if dx < inX and dy < inY then
                WorldWake(w, rr, c)
                dirty = true
            else if c.sp.mobile and c.alive then
                if now - c.dormAt > 4.0 then BrainDormant(w, rr, c, now - c.dormAt)
            end if
        end if
        i = i + 1
        if i >= n then i = 0
    end for
    w.scanAt = i
    if dirty then
        act = []
        hunters = []
        movers = []
        for each c in lst
            if c.active and not c.removed then
                act.Push(c)
                if c.sp.mv <> 3 then movers.Push(c)
                if c.sp.hunter or c.isPlayer then hunters.Push(c)
            end if
        end for
        w.act = act
        w.hunters = hunters
        w.movers = movers
        w.actDirty = false
    end if
end sub

sub WorldWake(w as object, rr as object, c as object)
    c.active = true
    c.px = c.x
    c.py = c.y
    c.simAt = w.time
    c.pAt = w.time
    c.nextThink = w.time + RngNext(w.rng) * 0.16
    c.stuckAt = w.time
    c.progX = c.x
    c.progY = c.y
    if c.sp.mobile then
        ' a sleeping swimmer may have drifted through rock: put it back in open water
        if TerrSdfFor(rr, c.x, c.y, c.length) < c.radius then
            TerrResolve(rr, c, c.radius, c.length)
            if not m.thit then
                c.x = c.wanderX
                c.y = c.wanderY
            else if TerrSdfFor(rr, c.x, c.y, c.length) < c.radius * 0.5 then
                c.x = c.wanderX
                c.y = c.wanderY
            end if
            c.px = c.x
            c.py = c.y
        end if
    end if
    c.clear = 0.0
end sub

' Run the whole region for a while with a big bubble (used once so the menu opens on a living reef).
sub WorldWarmUp(w as object, ticks as integer)
    for i = 1 to ticks
        WorldStep(w)
    end for
end sub
