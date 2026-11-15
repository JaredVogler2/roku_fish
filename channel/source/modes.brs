' ============================================================================
' modes.brs - game modes: Reef Ascension, the Tutorial, Classic Tournament, Challenge, Practice
' and the attract scene behind the menu. Ported from the web game's modes/*.ts.
'
' A mode is an associative array with an id; the functions below dispatch on it.
' ============================================================================

function ModeNew(id as string) as object
    md = {
        id: id
        passive: false
        ' ascension / tutorial
        invertsEaten: 0
        foundCleaner: false
        ateMedium: false
        visited: {}
        visitedCount: 0
        completed: {}
        completedCount: 0
        offered: {}
        ' tutorial
        tutorial: false
        stepIndex: 0
        stepTime: 0.0
        marker: invalid
        mealsAtStep: 0
        predatorId: -1
        hiddenTime: 0.0
        done: false
        ' ladder modes
        stage: 0
        stageStartScore: 0
        awaitingAdvance: false
        finished: false
        ladder: []
        label: ""
        seed: ""
    }
    if id = "tutorial" then md.tutorial = true
    if id = "tournament" then
        md.passive = true
        md.ladder = m.cfgData.tournamentladder
        md.label = "Classic Tournament"
    else if id = "challenge" then
        md.passive = true
        md.label = "Challenge"
    end if
    return md
end function

' Four species in ascending size / trophic order, favouring archetype variety.
function ChallengePick(seed as string) as object
    rng = RngNew(HashStr("challenge:" + seed))
    used = {}
    out = []
    for each pool in m.cfgData.challengepools
        opts = []
        for each id in pool
            sp = GetSpecies(id)
            if sp <> invalid then
                if not used.DoesExist(sp.archetype) then opts.Push(id)
            end if
        end for
        if opts.Count() = 0 then opts = pool
        pick = RngPick(rng, opts)
        used[GetSpecies(pick).archetype] = true
        out.Push(pick)
    end for
    return out
end function

function TutorialSteps() as object
    return [
        { id: "move", title: "Swim", text: "Use the D-pad to swim to the glowing ring. Hold a direction and your fish turns and accelerates smoothly." }
        { id: "eat", title: "Feed", text: "Swim close to the red plankton cloud and press OK. Your fish chases it and bites. Eating restores energy." }
        { id: "bars", title: "Energy and health", text: "Turquoise is energy: it drains as you swim. Coral is health: bites, stings and poison lower it. Either one reaching zero ends the run." }
        { id: "hide", title: "Hide!", text: "A lionfish is hunting. Duck into the seagrass or coral nearby and stay still until it gives up." }
        { id: "clean", title: "Get cleaned", text: "You were nicked. Follow the arrow to the cleaning station and hold still - the blue cleaner wrasse will heal you." }
        { id: "grow", title: "Grow", text: "Eat 3 more small meals (worms, shrimp, plankton). Watch your gold growth bar and your fish get bigger." }
        { id: "halos", title: "Read the reef", text: "Green rings are edible. Amber is risky. Red is dangerous or toxic. Grey you cannot eat. Press Replay to inspect a creature; the Field Guide is in the pause menu. You are ready!" }
    ]
end function

function AscensionGoals() as object
    return [
        { id: "firstMeal", text: "Eat your first meal" }
        { id: "inverts", text: "Eat 3 invertebrates" }
        { id: "cleaner", text: "Find a cleaning station" }
        { id: "survive3", text: "Survive 3 minutes" }
        { id: "juvenile", text: "Grow to Juvenile" }
        { id: "escape", text: "Escape a predator" }
        { id: "explore", text: "Explore 6 reef sectors" }
        { id: "double", text: "Grow to twice your hatch length" }
        { id: "medium", text: "Hunt a medium-sized fish" }
        { id: "apex", text: "Become the Apex Wrasse" }
    ]
end function

function GoalProgress(w as object, md as object, id as string) as float
    ps = w.ps
    if id = "firstMeal" then
        if ps.bites + ps.swallows > 0 then return 1.0
        return 0.0
    else if id = "inverts" then
        return MinF(1.0, md.invertsEaten / 3.0)
    else if id = "cleaner" then
        if md.foundCleaner then return 1.0
        return 0.0
    else if id = "survive3" then
        return MinF(1.0, ps.timeAlive / 180.0)
    else if id = "juvenile" then
        return MinF(1.0, ps.milestone / 2.0)
    else if id = "escape" then
        if ps.escapes > 0 then return 1.0
        return 0.0
    else if id = "explore" then
        return MinF(1.0, md.visitedCount / 6.0)
    else if id = "double" then
        return MinF(1.0, ps.milestone / 5.0)
    else if id = "medium" then
        if md.ateMedium then return 1.0
        return 0.0
    else if id = "apex" then
        return MinF(1.0, ps.milestone / 10.0)
    end if
    return 0.0
end function

sub ModeVisit(w as object, md as object)
    p = w.player
    if p = invalid then return
    key = w.rr.id + ":" + p.sector.ToStr()
    if not md.visited.DoesExist(key) then
        md.visited[key] = true
        md.visitedCount = md.visitedCount + 1
    end if
end sub

sub ModeInit(w as object)
    md = w.mode
    id = md.id
    if id = "ascension" or id = "tutorial" then
        ModeVisit(w, md)
        if id = "tutorial" then
            w.predatorsCalm = true
            TutorialEnterStep(w, md)
        end if
    else if id = "tournament" or id = "challenge" then
        md.stageStartScore = w.ps.score
    end if
end sub

sub ModeUpdate(w as object, dt as float)
    md = w.mode
    id = md.id
    p = w.player
    if p = invalid then return
    if not p.alive then return
    if id = "ascension" or id = "tutorial" then
        if w.tick MOD 15 = 0 then
            ModeVisit(w, md)
            for each g in AscensionGoals()
                if not md.completed.DoesExist(g.id) then
                    if GoalProgress(w, md, g.id) >= 1 then
                        md.completed[g.id] = true
                        md.completedCount = md.completedCount + 1
                        w.ps.score = w.ps.score + 250
                        WorldEmit(w, { ev: "OBJECTIVE_COMPLETE", id: g.id, text: g.text })
                    end if
                end if
            end for
        end if
        if id = "tutorial" and not md.done then TutorialUpdate(w, md, dt)
    else if id = "tournament" or id = "challenge" then
        if md.awaitingAdvance or md.finished then return
        ' passive survival points accrue only while exposed (never while hiding)
        ps = w.ps
        if not ps.hidden then
            ps.passiveAccum = ps.passiveAccum + 5.0 * dt
            if ps.passiveAccum >= 10 then
                pts = Int(ps.passiveAccum / 10) * 10
                ps.passiveAccum = ps.passiveAccum - pts
                ps.score = ps.score + pts
            end if
        end if
        if ps.score - md.stageStartScore >= LadderTarget(md, md.stage) then
            md.awaitingAdvance = true
            nxt = ""
            if md.stage + 1 < md.ladder.Count() then nxt = md.ladder[md.stage + 1]
            if nxt = "" then md.finished = true
            WorldEmit(w, { ev: "STAGE_CLEARED", stage: md.stage, nextSpecies: nxt, score: ps.score })
        end if
    end if
end sub

sub ModeOnEvent(w as object, e as object)
    md = w.mode
    id = md.id
    if id <> "ascension" and id <> "tutorial" then return
    ev = e.ev
    if ev = "FOOD_BITE" or ev = "FOOD_CONSUMED" then
        if not e.isPlayer then return
        sp = GetSpecies(e.speciesId)
        if sp = invalid then return
        inv = false
        for each t in sp.foodtags
            if t = "worm" or t = "smallCrustacean" or t = "crab" or t = "brittleStar" or t = "snail" or t = "mollusk" or t = "urchin" or t = "starfish" or t = "softBodiedInvertebrate" then inv = true
        end for
        if inv then md.invertsEaten = md.invertsEaten + 1
        if ev = "FOOD_CONSUMED" and sp.sizetag and sp.len > 0.85 then md.ateMedium = true
    else if ev = "CLEANING_STARTED" or ev = "CLEANER_UNAVAILABLE" then
        md.foundCleaner = true
    else if ev = "MILESTONE_REACHED" then
        ms = e.milestone
        unl = m.cfgData.regionunlockmilestone
        for each region in unl
            if ms >= unl[region] and not w.cfg.unlocked.DoesExist(region) then
                w.cfg.unlocked[region] = true
                WorldEmit(w, { ev: "REGION_UNLOCKED", region: region })
                WorldEmit(w, { ev: "HINT", text: "A reef pass has opened to the " + RegionName(region) + "!" })
            end if
        end for
        for each um in m.cfgData.upgrademilestones
            key = um.ToStr()
            if ms >= um and not md.offered.DoesExist(key) then
                md.offered[key] = true
                pool = []
                for each u in m.upgrades
                    if not ArrayHas(w.ps.upgrades, u.id) then pool.Push(u.id)
                end for
                rng = RngNew(HashStr(w.cfg.seed + ":upg:" + key))
                opts = []
                while opts.Count() < 3 and pool.Count() > 0
                    i = RngInt(rng, 0, pool.Count() - 1)
                    opts.Push(pool[i])
                    pool.Delete(i)
                end while
                if opts.Count() > 0 then
                    w.ps.pendingUpgrade = opts
                    WorldEmit(w, { ev: "UPGRADE_OFFERED" })
                end if
                exit for
            end if
        end for
        WorldEmit(w, { ev: "CHECKPOINT" })
    end if
end sub

' What the HUD shows as the current goal.
' Returns { title, detail, progress (-1 = none), items: [{ text, done, progress }] }
function ModeObjective(w as object) as object
    md = w.mode
    id = md.id
    ps = w.ps
    if id = "tutorial" and not md.done then
        steps = TutorialSteps()
        st = steps[md.stepIndex]
        return { title: "Tutorial " + (md.stepIndex + 1).ToStr() + "/" + steps.Count().ToStr() + ": " + st.title, detail: st.text, progress: md.stepIndex / steps.Count(), items: [] }
    end if
    if id = "ascension" or id = "tutorial" then
        items = []
        open = 0
        for each g in AscensionGoals()
            if open < 3 then
                prog = GoalProgress(w, md, g.id)
                done = (md.completed.DoesExist(g.id) or prog >= 1)
                if not done then
                    items.Push({ text: g.text, done: false, progress: prog })
                    open = open + 1
                end if
            end if
        end for
        ms = ps.milestone
        th = m.bal.growth.milestones
        names = m.bal.growth.milestonenames
        last = th.Count() - 1
        progress = 1.0
        detail = "Apex reached - survive and rule the reef."
        if ms < last then
            progress = (ps.mass - th[ms]) / (th[ms + 1] - th[ms])
            detail = "Grow to " + Chr(34) + names[ms + 1] + Chr(34)
        end if
        return { title: names[ms], detail: detail, progress: progress, items: items }
    end if
    if id = "tournament" or id = "challenge" then
        tgt = LadderTarget(md, md.stage)
        got = ps.score - md.stageStartScore
        if got < 0 then got = 0
        sp = GetSpecies(LadderCurrentSpecies(md))
        detail = "Score " + FmtInt(tgt) + " points this stage (" + FmtInt(got) + " so far)"
        if md.finished then detail = "Ladder complete!"
        return { title: "Stage " + (md.stage + 1).ToStr() + ": " + sp.name, detail: detail, progress: MinF(1.0, got / tgt), items: [] }
    end if
    if id = "practice" then
        d = "Free swim"
        if w.player <> invalid then d = "Free swim as a " + w.player.sp.name + ". Experiment with diet and abilities."
        return { title: "Practice", detail: d, progress: -1.0, items: [] }
    end if
    return { title: "", detail: "", progress: -1.0, items: [] }
end function

function ModeLabel(w as object) as string
    md = w.mode
    id = md.id
    if id = "tutorial" and not md.done then return "Learn the Reef"
    if id = "ascension" or id = "tutorial" then return "Reef Ascension"
    if id = "tournament" or id = "challenge" then return md.label
    if id = "practice" then return "Practice"
    return ""
end function

function ModeDeathOptions(w as object) as object
    id = w.mode.id
    if id = "ascension" or id = "tutorial" then return ["continueCheckpoint", "restartRun", "menu"]
    if id = "tournament" then return ["restartStage", "restartRun", "menu"]
    if id = "challenge" then return ["restartRun", "menu"]
    if id = "practice" then return ["respawn", "menu"]
    return ["menu"]
end function

' ---------------------------------------------------------------- ladders
function LadderTarget(md as object, stage as integer) as integer
    if md.id = "challenge" then
        t = m.bal.score.challengetargets
        if stage > 3 then stage = 3
        return t[stage]
    end if
    return TournamentTarget(stage)
end function

function LadderCurrentSpecies(md as object) as string
    i = md.stage
    if i > md.ladder.Count() - 1 then i = md.ladder.Count() - 1
    return md.ladder[i]
end function

' Move on to the next species after the stage card. Returns its id, or "" when the ladder is done.
function LadderAdvance(w as object) as string
    md = w.mode
    if not md.awaitingAdvance then return ""
    md.stage = md.stage + 1
    md.awaitingAdvance = false
    md.stageStartScore = w.ps.score
    if md.stage >= md.ladder.Count() then
        md.finished = true
        return ""
    end if
    if md.id = "tournament" then
        unl = m.cfgData.regionunlockstage
        for each region in unl
            if md.stage >= unl[region] and not w.cfg.unlocked.DoesExist(region) then
                w.cfg.unlocked[region] = true
                WorldEmit(w, { ev: "REGION_UNLOCKED", region: region })
            end if
        end for
    end if
    return md.ladder[md.stage]
end function

function LadderRestartStage(w as object) as string
    md = w.mode
    w.ps.score = md.stageStartScore
    md.awaitingAdvance = false
    return md.ladder[md.stage]
end function

' ---------------------------------------------------------------- tutorial
function TutorialSpawnNear(w as object, speciesId as string, dx as float, dy as float) as object
    p = w.player
    rr = w.rr
    x = WrapX(p.x + dx)
    y = p.y + dy
    for i = 0 to 19
        if TerrSdf(rr, x, y) >= 0.6 then exit for
        y = y + 0.5
        x = WrapX(x + 0.3)
    end for
    c = WorldAdd(w, GetSpecies(speciesId), x, y, 1.0, rr)
    c.homeX = c.x
    c.homeY = c.y
    w.actDirty = true
    return c
end function

sub TutorialEnterStep(w as object, md as object)
    md.stepTime = 0.0
    p = w.player
    if p = invalid then return
    steps = TutorialSteps()
    id = steps[md.stepIndex].id
    md.marker = invalid
    ps = w.ps
    rr = w.rr
    if id = "move" then
        md.marker = { x: WrapX(p.x + 5), y: p.y + 1.2 }
    else if id = "eat" then
        pl = TutorialSpawnNear(w, "plankton", 3.5, 0.5)
        md.marker = { x: pl.x, y: pl.y }
        md.mealsAtStep = ps.bites + ps.swallows
    else if id = "hide" then
        w.predatorsCalm = false
        sh = TerrNearestShelter(rr, p.x, p.y, p.length, 14.0)
        if sh <> invalid then md.marker = { x: sh.x, y: sh.y }
        pred = TutorialSpawnNear(w, "lionfish", -9.0, 2.0)
        pred.hungryAt = 0.0
        pred.homeX = p.x
        pred.homeY = p.y
        md.predatorId = pred.id
        md.hiddenTime = 0.0
    else if id = "clean" then
        w.predatorsCalm = true
        pred = WorldGet(w, md.predatorId)
        if pred <> invalid then
            pred.hungryAt = w.time + 60
            pred.targetId = -1
            pred.behavior = 0
            pred.wanderX = WrapX(pred.x - 15)
        end if
        if p.health > 62 then p.health = 62.0
        best = invalid
        bd = 99999.0
        for each st in rr.stations
            d = Dist(st.x, st.y, p.x, p.y)
            if d < bd then
                bd = d
                best = st
            end if
        end for
        if best <> invalid then md.marker = { x: best.x, y: best.y }
        ' make sure the station is open whatever the time of day
        w.dayTime = 0.45
        WorldSetPhase(w, PhaseOf(w.dayTime))
    else if id = "grow" then
        md.mealsAtStep = ps.bites + ps.swallows
        for i = 0 to 2
            TutorialSpawnNear(w, "plankton", 2.0 + i * 1.6, 1.0 + i * 0.6)
        end for
    end if
end sub

sub TutorialNext(w as object)
    md = w.mode
    if md.done then return
    md.stepIndex = md.stepIndex + 1
    if md.stepIndex >= TutorialSteps().Count() then
        TutorialFinish(w)
        return
    end if
    TutorialEnterStep(w, md)
end sub

sub TutorialFinish(w as object)
    md = w.mode
    md.done = true
    md.marker = invalid
    md.stepIndex = TutorialSteps().Count() - 1
    w.predatorsCalm = false
    WorldEmit(w, { ev: "HINT", text: "Tutorial complete! Keep growing - this run continues as Reef Ascension." })
    WorldEmit(w, { ev: "TUTORIAL_DONE" })
end sub

sub TutorialUpdate(w as object, md as object, dt as float)
    p = w.player
    ps = w.ps
    md.stepTime = md.stepTime + dt
    id = TutorialSteps()[md.stepIndex].id
    meals = ps.bites + ps.swallows
    if id = "move" then
        if md.marker <> invalid then
            if Dist(p.x, p.y, md.marker.x, md.marker.y) < 1.4 then TutorialNext(w)
        end if
    else if id = "eat" then
        if meals > md.mealsAtStep then
            TutorialNext(w)
        else if md.stepTime > 20 and (Int(md.stepTime) MOD 10) = 0 and w.tick MOD 30 = 0 then
            pl = TutorialSpawnNear(w, "plankton", 2.5, 0.3)
            md.marker = { x: pl.x, y: pl.y }
        end if
    else if id = "bars" then
        if md.stepTime > 7 then TutorialNext(w)
    else if id = "hide" then
        if ps.hidden then md.hiddenTime = md.hiddenTime + dt
        pred = WorldGet(w, md.predatorId)
        if md.hiddenTime > 3 or md.stepTime > 25 or pred = invalid then TutorialNext(w)
    else if id = "clean" then
        if p.health >= p.maxHealth * 0.98 or md.stepTime > 40 then TutorialNext(w)
    else if id = "grow" then
        if meals >= md.mealsAtStep + 3 then
            TutorialNext(w)
        else if md.stepTime > 15 and w.tick MOD 300 = 0 then
            TutorialSpawnNear(w, "plankton", 2.5, 0.8)
        end if
    else if id = "halos" then
        if md.stepTime > 9 then TutorialNext(w)
    end if
end sub
