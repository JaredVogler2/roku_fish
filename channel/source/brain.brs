' ============================================================================
' brain.brs - animal behaviour: perception, decisions, steering and movement.
'
' A port of the web game's ai/brain.ts and ai/perception.ts with the same states and tuning
' (wander, school, forage, pursue, search, flee, hide, ambush, rest, visit cleaner, clean, crawl,
' drift). Decisions happen 6 times a second per animal; steering and movement are stepped by WorldStep.
' Roku-specific economies: species-vs-species eligibility comes from the precomputed matrix,
' threat scans only look at hunters, line of sight is tested once per candidate, schooling
' forces are refreshed every third tick, and visibility every second tick.
' ============================================================================

' ---------------------------------------------------------------- perception
' Light available to an observer: daylight, depth and nocturnal adaptation.
function LightFactor(w as object, obs as object) as float
    dl = w.dl
    act = obs.sp.act
    if act = 2 or act = 3 then
        f = 0.85 + 0.15 * (1 - dl)
    else
        f = 0.5 + 0.5 * dl
    end if
    f = f * (0.82 + 0.18 * (obs.y / 40.5))
    if obs.abCount > 0 then
        if obs.ab.DoesExist("illuminate") then
            if f < 1.25 then f = 1.25
            if dl < 0.5 then
                f = f * 1.5
            else
                f = f * 1.1
            end if
        end if
    end if
    return f
end function

' Can obs perceive tgt at distance d? Caves break line of sight completely; cover reduces range.
function CanSee(w as object, obs as object, tgt as object, d as float) as boolean
    if (not tgt.alive) or tgt.removed then return false
    now = w.time
    blind = (now < obs.inkUntil)
    close = 0.55 + obs.length * 0.4 + tgt.radius
    rr = w.rr
    if tgt.hiddenIn >= 0 then
        sh = rr.shelters[tgt.hiddenIn]
        if sh.blockssight then
            if obs.hiddenIn = tgt.hiddenIn then return d < obs.sp.perception
            return (obs.length <= sh.clearance * 1.6 and d < close * 0.75 and not blind)
        end if
    end if
    if d < close and not blind then return true
    range = obs.sp.perception * obs.mPerception * LightFactor(w, obs)
    if blind then range = range * 0.2
    if tgt.isPlayer then range = range * w.diff.detection
    range = range * tgt.visibility
    if d > range then return false
    if w.inkCount > 0 then
        if InkBlocks(w, obs.x, obs.y, tgt.x, tgt.y) then return false
    end if
    if d > 2 then
        if not TerrLineOfSight(rr, obs.x, obs.y, tgt.x, tgt.y) then return false
    end if
    return true
end function

function InkBlocks(w as object, ax as float, ay as float, bx as float, by as float) as boolean
    now = w.time
    for each e in w.effects
        if e.kind = "ink" then
            t = now - e.t0
            grow = t / 0.6
            if grow > 1 then grow = 1.0
            fade = (t - e.dur + 1)
            if fade < 0 then fade = 0.0
            r = e.r * grow * (1 - fade)
            if r > 0.2 then
                ' distance from the cloud centre to the sight line
                dpx = DxWrap(ax, e.x)
                dpy = e.y - ay
                bxr = DxWrap(ax, bx)
                byr = by - ay
                l2 = bxr * bxr + byr * byr
                tt = 0.0
                if l2 > 0 then tt = ClampF((dpx * bxr + dpy * byr) / l2, 0.0, 1.0)
                ddx = bxr * tt - dpx
                ddy = byr * tt - dpy
                if ddx * ddx + ddy * ddy < r * r then return true
            end if
        end if
    end for
    return false
end function

' Hiding state and visibility (0 = invisible .. 1 = plain sight, above 1 when lit up).
sub UpdateVisibility(w as object, c as object)
    sp = c.sp
    rr = w.rr
    prev = c.hiddenIn
    h = -1
    if sp.mv <> 3 and sp.mv <> 4 then
        TerrShelterAt(rr, c.x, c.y, c.length)
        h = m.tsh
    end if
    c.hiddenIn = h
    vis = 1.0
    if h >= 0 then vis = 1.0 - rr.shelters[h].concealment
    still = (c.vx * c.vx + c.vy * c.vy < 0.2025)
    illum = false
    if c.abCount > 0 then
        if c.ab.DoesExist("camouflage") then
            near = (h >= 0 or c.clear < 1.2)
            if not near then near = (TerrSdfFast(rr, c.x, c.y) < 1.4)
            if still and near then
                vis = vis * 0.2
            else
                vis = vis * 0.6
            end if
        end if
        illum = c.ab.DoesExist("illuminate")
    end if
    if sp.ambush and c.behavior = 10 and still then vis = vis * 0.4
    if sp.mv = 5 and c.behavior = 5 then vis = vis * 0.1
    dl = w.dl
    vis = vis * (0.7 + 0.3 * dl)
    if illum then
        if vis < 1 then vis = 1.0
        if dl < 0.5 then
            vis = vis * 1.6
        else
            vis = vis * 1.15
        end if
    end if
    if sp.emissive <> "" and dl < 0.5 and vis < 0.8 then vis = 0.8
    c.visibility = vis
    if c.isPlayer and prev <> h then
        if h >= 0 then
            WorldEmit(w, { ev: "SHELTER_ENTERED", kind: rr.shelters[h].kind })
        else
            WorldEmit(w, { ev: "SHELTER_EXITED" })
        end if
    end if
end sub

' Refresh an animal's cached verdicts about the player (after the player grew or changed state).
sub BrainRefreshPv(w as object, c as object, p as object)
    c.pvStamp = w.playerVersion
    ms = WorldMilestone(w, p)
    c.pvThreat = IsThreatExact(w, p, c, ms)
    c.pvEat = 0
    if c.sp.diet.Count() > 0 and c.sp.mv <> 3 then
        CheckFeed(w, c, p, -1, true, false, false)
        f = m.fc
        if f.result = "SWALLOW" then
            c.pvEat = 1
        else if f.result = "BITE" then
            c.pvEat = 2
        end if
        if c.pvEat > 0 then
            c.pvPref = f.pref
            c.pvSpine = f.spine
            c.pvVal = MealEnergy(c, p, c.pvEat = 1)
        end if
    end if
    ' what the player would get from this animal (target rings)
    CheckFeed(w, p, c, ms, true, false, false)
    f = m.fc
    risk = f.risk
    if risk = 0 then
        ' not food: is it a danger instead?
        danger = (c.pvEat = 1)
        if c.pvEat = 2 and p.maxCharges <= 0 then danger = true
        if c.sp.role = "hazard" then danger = true
        if danger then risk = 3
    end if
    c.pvRisk = risk
    c.pvEdible = (f.result = "SWALLOW" or f.result = "BITE")
    c.pvFSpine = f.spine
    c.pvResult = f.result
    c.pvReason = f.reason
end sub

' ---------------------------------------------------------------- waypoints
sub PickWaypoint(w as object, c as object)
    rng = w.rng
    rr = w.rr
    sp = c.sp
    sector = c.homeSector
    if sp.patroller then
        if Rnd(0) < 0.55 then
            col = (sector MOD 3) + Int(Rnd(0) * 3) - 1
            row = sp.rows[Int(Rnd(0) * sp.rows.Count())]
            sector = row * 3 + ((col MOD 3) + 3) MOD 3
        end if
    end if
    x0 = (sector MOD 3) * 24.0
    y0 = (2 - sector \ 3) * 13.5
    g = rr.grid
    ' clearance wanted at the waypoint, in grid steps (0.04 units)
    need = 128 + Int((c.radius + 0.5) * 25.0)
    blo = sp.blo
    bspan = sp.bhi - blo
    for i = 0 to 9
        x = x0 + 1.0 + 22.0 * Rnd(0)
        y = y0 + (blo + bspan * Rnd(0)) * 13.5
        if g[Int(y * 4.0 + 0.5) * 289 + Int(x * 4.0 + 0.5)] > need then
            if PathClearFast(rr, c.x, c.y, x, y, c.radius) then
                c.wanderX = x
                c.wanderY = y
                c.wanderOk = true
                return
            end if
        end if
    end for
    ' Local fallback: any reachable open point nearby.
    need = 128 + Int((c.radius + 0.3) * 25.0)
    for i = 0 to 7
        a = 6.2831853 * Rnd(0)
        d = 1.5 + 3.5 * Rnd(0)
        x = c.x + Cos(a) * d
        if x >= 72 then
            x = x - 72
        else if x < 0 then
            x = x + 72
        end if
        y = c.y + Sin(a) * d
        if y < 0.5 then y = 0.5
        if y > 39.9 then y = 39.9
        if g[Int(y * 4.0 + 0.5) * 289 + Int(x * 4.0 + 0.5)] > need then
            if PathClearFast(rr, c.x, c.y, x, y, c.radius) then
                c.wanderX = x
                c.wanderY = y
                c.wanderOk = true
                return
            end if
        end if
    end for
    c.wanderX = c.x
    y = c.y + 1.5
    if y > 39.5 then y = 39.5
    c.wanderY = y
    c.wanderOk = true
end sub

' Straight-line check on the rock field only (cheap; shelters are left to collision).
function PathClearFast(rr as object, ax as float, ay as float, bx as float, by as float, radius as float) as boolean
    dx = bx - ax
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    dy = by - ay
    l = Sqr(dx * dx + dy * dy)
    steps = Int(l / 0.7) + 1
    ' radius in grid steps, plus a small margin
    need = 128 + Int((radius + 0.05) * 25.0)
    g = rr.grid
    for i = 1 to steps
        t = i / steps
        ix = Int((ax + dx * t) * 4.0 + 0.5) MOD 288
        if ix < 0 then ix = ix + 288
        iy = Int((ay + dy * t) * 4.0 + 0.5)
        if iy < 0 then iy = 0
        if iy > 162 then iy = 162
        if g[iy * 289 + ix] < need then return false
    end for
    return true
end function

' Best escape heading among 8: away from the threat, with room to swim.
sub EscapePoint(w as object, c as object, th as object)
    rr = w.rr
    ax = -DxWrap(c.x, th.x)
    ay = c.y - th.y
    al = Sqr(ax * ax + ay * ay)
    if al < 0.001 then al = 1.0
    ax = ax / al
    ay = ay / al
    bx = c.x + ax * 3
    by = c.y + ay * 3
    bestScore = -999.0
    rad = c.radius
    g = rr.grid
    dirs = m.dir8
    x = c.x
    y = c.y
    for i = 0 to 7
        dx = dirs[i * 2]
        dy = dirs[i * 2 + 1]
        px = x + dx * 3.2
        py = y + dy * 3.2
        if py > 0.4 and py < 40.0 then
            ix = Int(px * 4.0 + 0.5) MOD 288
            if ix < 0 then ix = ix + 288
            room = (g[Int(py * 4.0 + 0.5) * 289 + ix] - 128) * 0.04 - rad
            if room > 2 then room = 2.0
            if room >= 0.1 then
                ix = Int((x + dx * 1.6) * 4.0 + 0.5) MOD 288
                if ix < 0 then ix = ix + 288
                if (g[Int((y + dy * 1.6) * 4.0 + 0.5) * 289 + ix] - 128) * 0.04 > rad + 0.05 then
                    score = dx * ax + dy * ay + room * 0.35
                    if score > bestScore then
                        bestScore = score
                        bx = px
                        by = py
                    end if
                end if
            end if
        end if
    end for
    c.wanderX = WrapX(bx)
    c.wanderY = by
    c.wanderOk = true
end sub

sub GiveUpHunt(w as object, c as object)
    ps = w.ps
    if c.targetId > 0 then
        key = c.id.ToStr()
        if ps.chasedBy.DoesExist(key) then
            t = WorldGet(w, c.targetId)
            if t <> invalid then
                if t.isPlayer then
                    ps.chasedBy.Delete(key)
                    ps.chasedCount = ps.chasedCount - 1
                    WorldEmit(w, { ev: "PREDATOR_LOST", predatorId: c.id, speciesId: c.sp.id })
                    ps.escapes = ps.escapes + 1
                end if
            end if
        end if
    end if
    c.ignoreId = c.targetId
    c.ignoreUntil = w.time + 9
    c.targetId = -1
    SetBehavior(c, 0, w.time)
    PickWaypoint(w, c)
end sub

' A creature leaving the simulated bubble drops whatever it was chasing or fleeing.
sub BrainForget(w as object, c as object)
    ps = w.ps
    key = c.id.ToStr()
    if ps.chasedBy.DoesExist(key) then
        ps.chasedBy.Delete(key)
        ps.chasedCount = ps.chasedCount - 1
        WorldEmit(w, { ev: "PREDATOR_LOST", predatorId: c.id, speciesId: c.sp.id })
        ps.escapes = ps.escapes + 1
    end if
    c.targetId = -1
    c.threatId = -1
    if c.sp.schooling then
        c.behavior = 1
    else
        c.behavior = 0
    end if
    c.bsince = w.time
    c.wanderOk = true
    c.wanderX = c.x
    c.wanderY = c.y
end sub

sub DefensiveAbility(w as object, c as object, threat as object, d as float)
    if d > 2.6 + threat.length * 0.5 then return
    now = w.time
    for each ab in c.sp.abilities
        if ab <> "none" and ab <> "lure" and ab <> "illuminate" and ab <> "cleanerMimic" then
            if CooldownLeft(c, ab, now) <= 0 then
                if not (ab = "camouflage" and c.hiddenIn < 0) then
                    if Rnd(0) < 0.5 then AbilityActivate(w, c, ab)
                    return
                end if
            end if
        end if
    end for
end sub

' How often a creature is moved (in ticks). What the player interacts with is stepped most often,
' because it is drawn closest to where the simulation has it; the rest of the reef needs less.
sub BrainSetPeriod(w as object, c as object)
    per = 3
    p = w.player
    if p <> invalid then
        if c.targetId = p.id or w.ps.targetId = c.id then
            per = 1
        else
            dx = c.x - p.x
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            dy = c.y - p.y
            d2 = dx * dx + dy * dy
            if d2 < 30 or c.behavior = 4 then
                per = 2
            else if d2 > 70 then
                per = 4
            end if
        end if
    end if
    c.period = per
end sub

' ============================================================================ think
sub BrainThink(w as object, c as object)
    sp = c.sp
    now = w.time
    w.diagThinks = w.diagThinks + 1
    if now < c.stunUntil then
        SetBehavior(c, 8, now)
        return
    end if
    if c.lunging or now < c.freezeUntil then return
    mv = sp.mv
    if mv = 3 then
        c.nextThink = now + 30
        return
    end if
    if mv = 4 then
        ThinkDrift(w, c)
        return
    end if
    if mv = 2 or mv = 5 then
        ThinkCrawler(w, c)
        return
    end if
    if sp.cleaner <> "" then
        ThinkCleaner(w, c)
        return
    end if

    rng = w.rng
    rr = w.rr
    act = w.actLv[sp.act]
    BrainSetPeriod(w, c)
    hungry = false
    if now >= c.hungryAt then
        if act >= 1 then
            hungry = true
        else
            hungry = (Rnd(0) < act * 0.6)
        end if
    end if
    range = sp.perception * c.mPerception
    range2 = range * range
    cx = c.x
    cy = c.y
    cid = c.id
    sidx = c.sidx
    ps = w.ps
    N = m.speciesBase

    ' ---------- threats: only hunters can be threats
    threat = invalid
    threatScore = 99999.0
    threatMat = m.threat
    for each o in w.hunters
        if o.id <> cid and o.alive then
            dx = o.x - cx
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            dy = o.y - cy
            d2 = dx * dx + dy * dy
            if d2 <= range2 then
                isThreat = false
                if o.isPlayer then
                    if not w.predatorsCalm then
                        mimic = false
                        if o.abCount > 0 then mimic = o.ab.DoesExist("cleanerMimic")
                        if not mimic then
                            if c.pvStamp <> w.playerVersion then BrainRefreshPv(w, c, o)
                            isThreat = c.pvThreat
                        end if
                    end if
                else if o.sp.role = "hazard" then
                    isThreat = true
                else if sidx < N and o.sidx < N then
                    isThreat = (threatMat[o.sidx][sidx] = 1)
                end if
                if isThreat then
                    d = Sqr(d2)
                    if CanSee(w, c, o, d) then
                        score = d
                        hunting = (o.targetId = cid)
                        if o.isPlayer then hunting = (ps.targetId = cid)
                        if hunting then score = score / 2
                        if o.sp.role = "hazard" then score = score / 0.6
                        if score < threatScore then
                            threatScore = score
                            threat = o
                        end if
                    end if
                end if
            end if
        end if
    end for

    ' ---------- prey: look up the species matrix, rank by preference x energy / distance
    prey = invalid
    preyU = 0.0
    preyD = 0.0
    ' (not while already hunting or fleeing, and not again right after an empty scan)
    scan = (hungry and sidx < N and now >= c.scanAt)
    if scan then scan = (c.behavior <> 3 and c.behavior <> 13 and sp.diet.Count() > 0)
    if scan then
        eatMode = m.eatMode
        eatBase = sidx * N
        ambushing = (sp.ambush and c.behavior = 10)
        ambushR = c.length * 2.2 + 1.4
        for each o in w.act
            if o.id <> cid and o.alive then
                dx = o.x - cx
                if dx > 36 then
                    dx = dx - 72
                else if dx < -36 then
                    dx = dx + 72
                end if
                dy = o.y - cy
                d2 = dx * dx + dy * dy
                if d2 <= range2 then
                    mode = 0
                    pref = 0.0
                    val = 0.0
                    if o.isPlayer then
                        if not (w.predatorsCalm or w.cfg.invulnerable or now < w.spawnGraceUntil) then
                            if c.pvStamp <> w.playerVersion then BrainRefreshPv(w, c, o)
                            mode = c.pvEat
                            if mode > 0 then
                                if c.pvSpine >= 12 then
                                    mode = 0
                                else
                                    pref = c.pvPref
                                    val = c.pvVal
                                end if
                            end if
                        end if
                    else if o.sidx < N then
                        k = eatBase + o.sidx
                        mode = eatMode[k]
                        if mode > 0 then
                            if m.eatSpine[k] >= 12 then
                                mode = 0
                            else
                                pref = m.eatPref[k]
                                val = m.eatVal[k]
                            end if
                        end if
                    end if
                    if mode > 0 then
                        ok = true
                        if o.id = c.ignoreId and now < c.ignoreUntil then ok = false
                        if ok and o.maxCharges > 0 then
                            if CreatureCharges(o, now) <= 0 then ok = false
                        end if
                        if ok then
                            hx = o.x - c.homeX
                            if hx > 36 then
                                hx = hx - 72
                            else if hx < -36 then
                                hx = hx + 72
                            end if
                            hy = o.y - c.homeY
                            if hx * hx + hy * hy > 1444 then ok = false
                        end if
                        if ok then
                            d = Sqr(d2)
                            if ambushing and d > ambushR then ok = false
                            if ok then
                                u = pref * val / (1 + d * 0.35)
                                if o.isPlayer then u = u * 0.9 * w.diff.chasepersistence
                                if o.hiddenIn >= 0 then
                                    ' prey tucked into a shelter too small for us is not worth circling
                                    if c.length > rr.shelters[o.hiddenIn].clearance then
                                        u = 0.0
                                    else
                                        u = u * 0.5
                                    end if
                                end if
                                if u > preyU then
                                    preyU = u
                                    prey = o
                                    preyD = d
                                end if
                            end if
                        end if
                    end if
                end if
            end if
        end for
        ' line of sight is checked once, for the winner
        if prey <> invalid then
            if not CanSee(w, c, prey, preyD) then prey = invalid
        end if
        if prey = invalid then c.scanAt = now + 0.45 + Rnd(0) * 0.4
    end if

    ' ---------- flee
    if threat <> invalid then
        d = Dist(cx, cy, threat.x, threat.y)
        hunting = (threat.targetId = cid)
        fr = 2.2 + threat.length * 1.4
        if hunting then fr = fr + 3
        if fr > range then fr = range
        if not (threat.behavior = 3 or hunting) then fr = fr * 0.65
        hazardNear = (threat.sp.role = "hazard" and d < 2.5)
        if d < fr or hazardNear then
            if c.behavior = 3 then c.targetId = -1
            c.threatId = threat.id
            c.calmUntil = now + 1.6
            hide = false
            if c.hiddenIn >= 0 then hide = (rr.shelters[c.hiddenIn].concealment > 0.5)
            if hide then
                SetBehavior(c, 5, now)
            else
                SetBehavior(c, 4, now)
                ' choose where to flee: a shelter on the far side, otherwise the clearest heading away
                sh = TerrNearestShelter(rr, cx, cy, c.length, 7.0)
                went = false
                if sh <> invalid then
                    away = (DxWrap(cx, sh.x) * DxWrap(cx, threat.x) + (sh.y - cy) * (threat.y - cy) < 0)
                    if away then
                        if PathClearFast(rr, cx, cy, sh.x, sh.y, c.radius) then
                            c.wanderX = sh.x
                            c.wanderY = sh.y
                            c.wanderOk = true
                            went = true
                        end if
                    end if
                end if
                if not went then EscapePoint(w, c, threat)
            end if
            DefensiveAbility(w, c, threat, d)
            return
        end if
    end if
    if c.behavior = 4 or c.behavior = 5 then
        if now < c.calmUntil then return
        if c.behavior = 4 and c.hiddenIn >= 0 then
            SetBehavior(c, 5, now)
            c.hideUntil = now + (2 + (5 - (2)) * Rnd(0))
            return
        end if
        if c.behavior = 5 and now < c.hideUntil then return
        c.threatId = -1
        if sp.schooling then
            SetBehavior(c, 1, now)
        else
            SetBehavior(c, 0, now)
        end if
        PickWaypoint(w, c)
    end if

    ' ---------- continue pursuit
    if c.behavior = 3 or c.behavior = 13 then
        t = WorldGet(w, c.targetId)
        alive = false
        if t <> invalid then alive = t.alive
        if not alive then
            c.targetId = -1
            SetBehavior(c, 0, now)
            PickWaypoint(w, c)
        else
            d = Dist(cx, cy, t.x, t.y)
            visible = CanSee(w, c, t, d)
            if visible and t.hiddenIn >= 0 then
                if c.length > rr.shelters[t.hiddenIn].clearance then visible = false
            end if
            if visible then
                c.lastSeenX = t.x
                c.lastSeenY = t.y
                c.lastSeenAt = now
                SetBehavior(c, 3, now)
            else if now - c.lastSeenAt > 3.2 then
                GiveUpHunt(w, c)
                return
            else
                SetBehavior(c, 13, now)
            end if
            maxChase = 7.0
            if t.isPlayer then maxChase = 9 + 7 * w.diff.chasepersistence
            if sp.ambush then maxChase = maxChase * 0.4
            if now - c.huntStart > maxChase or Dist(t.x, t.y, c.homeX, c.homeY) > 38 then
                GiveUpHunt(w, c)
                return
            end if
            if now < c.hungryAt then
                GiveUpHunt(w, c)
                return
            end if
            return
        end if
    end if

    ' ---------- start hunting / foraging
    if prey <> invalid then
        c.targetId = prey.id
        c.lastSeenX = prey.x
        c.lastSeenY = prey.y
        c.lastSeenAt = now
        c.huntStart = now
        if prey.sp.mobile then
            SetBehavior(c, 3, now)
        else
            SetBehavior(c, 2, now)
        end if
        if prey.isPlayer then
            key = cid.ToStr()
            if not ps.chasedBy.DoesExist(key) then
                ps.chasedBy[key] = true
                ps.chasedCount = ps.chasedCount + 1
                WorldEmit(w, { ev: "PREDATOR_SPOTTED", predatorId: cid, speciesId: sp.id })
                if c.length > ps.biggestPredatorLen then
                    ps.biggestPredatorLen = c.length
                    ps.biggestPredator = sp.id
                end if
            end if
        end if
        if prey.sp.ambush or sp.burstsprint then
            if preyD < 5 and CooldownLeft(c, "burstSprint", now) <= 0 then
                if Rnd(0) < 0.3 then AbilityActivate(w, c, "burstSprint")
            end if
        end if
        return
    end if
    if c.behavior = 2 then
        ' keep grazing the same patch while it still has food and we are still hungry
        t = WorldGet(w, c.targetId)
        if t <> invalid then
            if t.alive and now >= c.hungryAt then
                if t.maxCharges <= 0 then return
                if CreatureCharges(t, now) > 0 then return
            end if
        end if
        c.targetId = -1
    end if

    ' ---------- visit a cleaner when injured
    if c.health < c.maxHealth * 0.55 and c.behavior <> 14 then
        for each st in rr.stations
            if Dist(st.x, st.y, cx, cy) < 16 then
                SetBehavior(c, 14, now)
                c.wanderX = st.x
                c.wanderY = st.y + 0.6
                c.wanderOk = true
                return
            end if
        end for
    end if
    if c.behavior = 14 then
        if c.health >= c.maxHealth * 0.95 or now - c.bsince > 25 then
            SetBehavior(c, 0, now)
            PickWaypoint(w, c)
        end if
        return
    end if

    ' ---------- rest outside the activity window
    if act < 1 then
        resting = (c.behavior = 7 and now - c.bsince < 20)
        if resting then return
        if Rnd(0) < (1 - act) * 0.5 then
            sh = TerrNearestShelter(rr, c.homeX, c.homeY, c.length, 12.0)
            SetBehavior(c, 7, now)
            went = false
            if sh <> invalid then
                if PathClearFast(rr, cx, cy, sh.x, sh.y, c.radius) then
                    c.wanderX = WrapX(sh.x + (-sh.hw * 0.5 + (sh.hw * 0.5 - (-sh.hw * 0.5)) * Rnd(0)))
                    c.wanderY = sh.y + (-sh.hh * 0.4 + (sh.hh * 0.4 - (-sh.hh * 0.4)) * Rnd(0))
                    went = true
                end if
            end if
            if not went then
                c.wanderX = cx
                c.wanderY = cy
            end if
            c.wanderOk = true
            return
        end if
    end if

    ' ---------- idle behaviours
    if sp.ambush then
        if c.behavior <> 10 then
            SetBehavior(c, 10, now)
            c.wanderX = c.homeX
            c.wanderY = c.homeY
            c.wanderOk = true
            if sp.abset.DoesExist("camouflage") then
                if CooldownLeft(c, "camouflage", now) <= 0 then AbilityActivate(w, c, "camouflage")
            end if
        end if
        if sp.abset.DoesExist("lure") then
            if CooldownLeft(c, "lure", now) <= 0 then
                if Rnd(0) < 0.1 then AbilityActivate(w, c, "lure")
            end if
        end if
        return
    end if
    if sp.schooling then
        SetBehavior(c, 1, now)
        st = c.school
        if st <> invalid then
            if now > st.until or Dist(cx, cy, st.x, st.y) < 1.2 then
                PickWaypoint(w, c)
                st.x = c.wanderX
                st.y = c.wanderY
                st.until = now + (6 + (14 - (6)) * Rnd(0))
            end if
        end if
        return
    end if
    if c.behavior <> 0 then
        SetBehavior(c, 0, now)
        PickWaypoint(w, c)
    end if
    if Dist(cx, cy, c.wanderX, c.wanderY) < 1 + c.length * 0.5 or now - c.bsince > 14 then
        PickWaypoint(w, c)
        c.bsince = now
    end if
end sub

sub ThinkDrift(w as object, c as object)
    now = w.time
    SetBehavior(c, 12, now)
    if Dist(c.x, c.y, c.wanderX, c.wanderY) < 1 or now - c.bsince > 20 then
        s = c.homeSector
        x0 = (s MOD 3) * 24.0
        y0 = (2 - s \ 3) * 13.5
        c.wanderX = WrapX(x0 + (1 + (23 - (1)) * Rnd(0)))
        c.wanderY = ClampF(c.y + (-2.5 + (2.5 - (-2.5)) * Rnd(0)), y0 + 1.2, y0 + 13.0)
        c.wanderOk = true
        c.bsince = now
    end if
    c.nextThink = now + 0.5
end sub

sub ThinkCrawler(w as object, c as object)
    now = w.time
    ps = w.ps
    threatNear = false
    r = 2.2 + c.length * 2
    r2 = r * r
    cid = c.id
    for each o in w.hunters
        if o.alive and o.id <> cid then
            targeting = (o.targetId = cid)
            if o.isPlayer then targeting = (ps.targetId = cid)
            if targeting then
                dx = DxWrap(c.x, o.x)
                dy = o.y - c.y
                if dx * dx + dy * dy <= r2 then threatNear = true
            end if
        end if
    end for
    burrow = (c.sp.mv = 5)
    if threatNear then
        ' Burrowers duck underground for a few seconds, then must surface: a patient hunter
        ' waiting nearby gets a chance when they reappear.
        if burrow and c.behavior = 5 and now < c.hideUntil then return
        if burrow and now > c.hideUntil + 3 then
            SetBehavior(c, 5, now)
            c.hideUntil = now + 3
        else
            SetBehavior(c, 4, now)
        end if
        return
    end if
    if c.behavior = 5 and now < c.hideUntil then return
    if c.behavior = 4 and now - c.bsince < 1.5 then return
    act = w.actLv[c.sp.act]
    if act < 1 and Rnd(0) < 0.3 then
        SetBehavior(c, 7, now)
    else
        SetBehavior(c, 11, now)
    end if
    if Rnd(0) < 0.1 then c.crawlDir = -c.crawlDir
    c.nextThink = now + 0.25
end sub

sub ThinkCleaner(w as object, c as object)
    now = w.time
    rr = w.rr
    act = 0.2
    cact = 0
    if c.sp.cleaner = "day" then
        cact = 1
    else if c.sp.cleaner = "night" then
        cact = 2
    end if
    if IsActive(cact, w.phase) then
        SetBehavior(c, 6, now)
    else
        SetBehavior(c, 7, now)
    end if
    if c.station <> invalid then
        c.homeX = c.station.x
        c.homeY = c.station.y
    end if
    if now - c.bsince > 2.5 or Dist(c.x, c.y, c.wanderX, c.wanderY) < 0.25 then
        r = 0.35
        if c.behavior = 6 then r = 0.9
        x = WrapX(c.homeX + (-r + (r - (-r)) * Rnd(0)))
        if c.sp.mv = 1 then
            y = c.homeY + (-0.4 + (0.0 - (-0.4)) * Rnd(0))
        else
            y = c.homeY + (-0.2 + (0.7 - (-0.2)) * Rnd(0))
        end if
        if TerrSdfFor(rr, x, y, c.length) > c.radius then
            c.wanderX = x
            c.wanderY = y
            c.wanderOk = true
        end if
        c.bsince = now
    end if
    c.nextThink = now + 0.3
end sub

' ============================================================================ steering
sub BrainSteer(w as object, c as object, dt as float)
    sp = c.sp
    mv = sp.mv
    if mv = 3 or mv = 2 or mv = 5 then return
    now = w.time
    cruise = sp.swim * c.mSpeed
    burst = sp.burst * c.mSpeed * c.mBurst
    c.wantBurst = false
    if c.lunging then return
    if now < c.stunUntil then
        c.steerX = 0.0
        c.steerY = -0.2
        return
    end if
    b = c.behavior
    tx = c.wanderX
    ty = c.wanderY
    speed = cruise * 0.75
    arrive = 1.5
    if b = 3 or b = 2 then
        t = invalid
        if c.targetId > 0 then
            t = w.byId[c.targetId]
            if t <> invalid then
                if t.removed then t = invalid
            end if
        end if
        if t = invalid then
            speed = cruise
            arrive = 1.2
        else
            ddx = t.x - c.x
            if ddx > 36 then
                ddx = ddx - 72
            else if ddx < -36 then
                ddx = ddx + 72
            end if
            ddy = t.y - c.y
            d = Sqr(ddx * ddx + ddy * ddy)
            lead = d
            if burst > 1 then lead = d / burst
            if lead > 0.6 then lead = 0.6
            tx = t.x + t.vx * lead
            ty = t.y + t.vy * lead
            fast = (b = 3 and d < 7)
            if fast then
                speed = burst * 0.9
                c.wantBurst = true
            else
                speed = cruise
            end if
            if b = 2 then
                arrive = 0.4
            else
                arrive = 0.1
            end if
            range = c.length * 1.1 + t.radius + 0.25
            if d < range and now >= c.lungeReadyAt then
                go = true
                if sp.ambush then
                    ' ambushers strike when the prey is in front, or very close
                    fl = d
                    if fl < 0.001 then fl = 1.0
                    front = (ddx * c.hx + ddy * c.hy) / fl
                    go = (front > 0 or d < range * 0.7)
                end if
                if go then CombatStartLunge(w, c, t)
            end if
        end if
    else if b = 13 then
        tx = c.lastSeenX
        ty = c.lastSeenY
        speed = cruise * 1.1
        arrive = 0.8
    else if b = 4 then
        c.wantBurst = true
        if c.wanderOk then
            speed = burst
            arrive = 0.3
        else
            th = invalid
            if c.threatId > 0 then th = w.byId[c.threatId]
            if th <> invalid then
                dx = c.x - th.x
                if dx > 36 then
                    dx = dx - 72
                else if dx < -36 then
                    dx = dx + 72
                end if
                dy = c.y - th.y
                d = Sqr(dx * dx + dy * dy)
                if d < 0.001 then d = 1.0
                c.steerX = dx / d * burst
                c.steerY = dy / d * burst
            end if
            SteerAvoid(w, c)
            return
        end if
    else if b = 5 then
        if c.hiddenIn >= 0 then
            sh = w.rr.shelters[c.hiddenIn]
            tx = sh.x
            ty = sh.y
            speed = cruise * 0.3
            arrive = 1.0
        else
            speed = cruise * 0.6
            arrive = 0.6
        end if
    else if b = 7 then
        speed = cruise * 0.35
        arrive = 1.0
    else if b = 10 then
        speed = cruise * 0.3
        arrive = 1.5
    else if b = 6 then
        speed = cruise * 0.55
        arrive = 0.4
    else if b = 14 then
        speed = cruise * 0.8
        arrive = 1.2
    else if b = 12 then
        speed = cruise
        arrive = 2.0
    else if b = 1 then
        SteerSchool(w, c, cruise)
        SteerAvoid(w, c)
        return
    end if
    ' seek
    dx = tx - c.x
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    dy = ty - c.y
    d = Sqr(dx * dx + dy * dy)
    if d < 0.001 then
        c.steerX = 0.0
        c.steerY = 0.0
    else
        s = speed
        if d < arrive then s = speed * (d / arrive)
        c.steerX = dx / d * s
        c.steerY = dy / d * s
    end if
    if b = 12 then
        tt = now * 0.4 + c.id
        c.steerX = c.steerX + Sin(tt) * 0.15
        c.steerY = c.steerY + Cos(tt * 0.7) * 0.1
    end if
    SteerAvoid(w, c)
end sub

' Obstacle avoidance and keeping to the depth rows the species lives in.
sub SteerAvoid(w as object, c as object)
    sp = c.sp
    vx = c.vx
    vy = c.vy
    v = Sqr(vx * vx + vy * vy)
    look = 0.5 + c.length * 0.6 + v * 0.4
    ' probing ahead costs a terrain sample: calm swimmers do it on alternate updates
    probe = (c.clear <= look + 0.5)
    if probe and c.period > 1 then
        b = c.behavior
        if b <> 3 and b <> 4 then
            c.probeFlip = not c.probeFlip
            if c.probeFlip then
                probe = false
                c.steerX = c.steerX + c.avX
                c.steerY = c.steerY + c.avY
            end if
        end if
    end if
    c.avX = 0.0
    c.avY = 0.0
    if probe then
        if v > 0.1 then
            hx = vx / v
            hy = vy / v
        else
            hx = c.hx
            hy = c.hy
        end if
        px = c.x + hx * look
        if px >= 72 then
            px = px - 72
        else if px < 0 then
            px = px + 72
        end if
        TerrSample(w.rr, px, c.y + hy * look, c.length)
        d = m.td
        margin = c.radius + 0.35
        if d < margin then
            nx = m.tnx
            ny = m.tny
            strength = (margin - d) * 5 + 1.2
            sx = c.steerX + nx * strength
            sy = c.steerY + ny * strength
            ' slide along the surface rather than stopping dead
            tdot = sx * -ny + sy * nx
            if tdot >= 0 then
                sx = sx - ny * 0.4
                sy = sy + nx * 0.4
            else
                sx = sx + ny * 0.4
                sy = sy - nx * 0.4
            end if
            c.avX = sx - c.steerX
            c.avY = sy - c.steerY
            c.steerX = sx
            c.steerY = sy
        end if
    end if
    ' rows
    lo = (2 - sp.rowmax) * 13.5 + 0.3
    hi = (3 - sp.rowmin) * 13.5 - 0.3
    y = c.y
    if y < lo then c.steerY = c.steerY + (lo - y) * 1.5
    if y > hi then
        if c.behavior <> 3 and c.behavior <> 4 then c.steerY = c.steerY - (y - hi) * 1.5
    end if
    if y > 39.6 then c.steerY = c.steerY - (y - 39.6) * 4
end sub

' Boids: separation, alignment and cohesion with schoolmates plus a shared waypoint.
sub SteerSchool(w as object, c as object, cruise as float)
    st = c.school
    if (w.tick + c.id) MOD 3 <> 0 and c.schOk then
        c.steerX = c.schX
        c.steerY = c.schY
        return
    end if
    tx = c.wanderX
    ty = c.wanderY
    sx = 0.0
    sy = 0.0
    ax = 0.0
    ay = 0.0
    cx = 0.0
    cy = 0.0
    n = 0
    if st <> invalid then
        tx = st.x
        ty = st.y
        R = 1.8 + c.length
        R2 = R * R
        sepR = 0.55 + c.length * 0.6
        x = c.x
        y = c.y
        cid = c.id
        for each o in st.members
            if o.id <> cid and o.alive and o.active then
                dx = o.x - x
                if dx > 36 then
                    dx = dx - 72
                else if dx < -36 then
                    dx = dx + 72
                end if
                dy = o.y - y
                d2 = dx * dx + dy * dy
                if d2 <= R2 then
                    d = Sqr(d2)
                    if d < 0.001 then d = 0.001
                    if d < sepR then
                        k = (sepR - d) / d
                        sx = sx - dx * k
                        sy = sy - dy * k
                    end if
                    ax = ax + o.vx
                    ay = ay + o.vy
                    cx = cx + dx
                    cy = cy + dy
                    n = n + 1
                end if
            end if
        end for
    end if
    gx = tx - c.x
    if gx > 36 then
        gx = gx - 72
    else if gx < -36 then
        gx = gx + 72
    end if
    gy = ty - c.y
    gd = Sqr(gx * gx + gy * gy)
    if gd < 0.001 then gd = 1.0
    vx = gx / gd * cruise * 0.7
    vy = gy / gd * cruise * 0.7
    if n > 0 then
        coh = c.sp.cohesion
        vx = vx + (ax / n) * 0.5 * coh + (cx / n) * 1.1 * coh + sx * 4.5
        vy = vy + (ay / n) * 0.5 * coh + (cy / n) * 1.1 * coh + sy * 4.5
    end if
    l = Sqr(vx * vx + vy * vy)
    mx = cruise * 1.1
    if l > mx then
        vx = vx / l * mx
        vy = vy / l * mx
    end if
    c.steerX = vx
    c.steerY = vy
    c.schX = vx
    c.schY = vy
    c.schOk = true
end sub

' ============================================================================ integration
' Movement for one creature over `dt` seconds (the player and lunging animals every tick, other
' swimmers every second tick, crawlers every fourth - see WorldStep).
' Headings are unit vectors (hx, hy) rather than angles: turning is a rotation toward the wanted
' direction by at most turnRate * dt, done with a small-angle rotation, so the hot path needs no
' trigonometry at all.
sub BrainIntegrate(w as object, c as object, dt as float)
    sp = c.sp
    mv = sp.mv
    now = w.time
    if mv = 2 or mv = 5 or (mv = 1 and c.surface <> invalid) then
        IntegrateCrawler(w, c, dt)
        c.visN = c.visN + 1
        if c.visN >= 2 then
            c.visN = 0
            UpdateVisibility(w, c)
        end if
        return
    end if

    ' ---- swimmers, hoverers and drifters
    sx = c.steerX
    sy = c.steerY
    if now < c.freezeUntil then
        sx = sx * 0.1
        sy = sy * 0.1
    end if
    lunging = c.lunging
    accel = sp.accel * c.mSpeed
    if lunging then
        maxSpeed = sp.burst * 1.35
        accel = accel * 1.6
    else if c.wantBurst then
        maxSpeed = sp.burst * c.mBurst
        accel = accel * 1.6
    else if now < c.burstUntil then
        maxSpeed = sp.burst * c.mBurst
    else
        maxSpeed = sp.swim
    end if
    maxSpeed = maxSpeed * c.mSpeed
    if c.inflated then maxSpeed = maxSpeed * 0.4
    sl = Sqr(sx * sx + sy * sy)
    des = sl
    if des > maxSpeed then des = maxSpeed
    vx = c.vx
    vy = c.vy
    cur = Sqr(vx * vx + vy * vy)
    hx = c.hx
    hy = c.hy
    if cur > 0.08 then
        dirx = vx / cur
        diry = vy / cur
    else
        dirx = hx
        diry = hy
    end if
    hover = (mv = 1 or mv = 4)
    if des > 0.05 then
        ux = sx / sl
        uy = sy / sl
        turn = c.turnRate * dt
        if lunging then turn = turn * 1.4
        dot = dirx * ux + diry * uy
        ' cos / sin of the turn step (accurate enough below ~0.9 rad)
        ct = 1 - turn * turn * 0.5 + turn * turn * turn * turn * 0.0416667
        al = 1.0
        if dot >= ct then
            dirx = ux
            diry = uy
        else if hover and dot < -0.416 then
            ' hovering animals (seahorses, cleaner shrimp) back up slowly instead of turning
            lim = accel * dt
            ddx = sx - vx
            ddy = sy - vy
            if ddx > lim then
                ddx = lim
            else if ddx < -lim then
                ddx = -lim
            end if
            if ddy > lim then
                ddy = lim
            else if ddy < -lim then
                ddy = -lim
            end if
            vx = vx + ddx
            vy = vy + ddy
            al = -9.0
        else
            st = turn - turn * turn * turn * 0.1666667
            if dirx * uy - diry * ux >= 0 then
                nx = dirx * ct - diry * st
                diry = diry * ct + dirx * st
            else
                nx = dirx * ct + diry * st
                diry = diry * ct - dirx * st
            end if
            dirx = nx
            al = dirx * ux + diry * uy
        end if
        if al > -5 then
            if hover then
                target = des
            else
                k = 0.35 + 0.65 * al
                if k < 0.25 then k = 0.25
                target = des * k
            end if
            dv = target - cur
            if dv > accel * dt then
                dv = accel * dt
            else if dv < -accel * 1.4 * dt then
                dv = -accel * 1.4 * dt
            end if
            spd = cur + dv
            vx = dirx * spd
            vy = diry * spd
        end if
    else
        drag = 1 - 2.2 * dt
        if drag < 0 then drag = 0.0
        vx = vx * drag
        vy = vy * drag
    end if
    c.vx = vx
    c.vy = vy
    sp2 = Sqr(vx * vx + vy * vy)
    ' the body turns toward its motion at up to 8 rad/s; a nearly still fish keeps its heading
    if sp2 > 0.12 then
        wx = vx / sp2
        wy = vy / sp2
        dot = hx * wx + hy * wy
        backing = (hover and dot < -0.588)
        if not backing then
            turn = 8 * dt
            ct = 1 - turn * turn * 0.5 + turn * turn * turn * turn * 0.0416667
            if dot >= ct then
                hx = wx
                hy = wy
            else
                st = turn - turn * turn * turn * 0.1666667
                if hx * wy - hy * wx >= 0 then
                    nx = hx * ct - hy * st
                    hy = hy * ct + hx * st
                else
                    nx = hx * ct + hy * st
                    hy = hy * ct - hx * st
                end if
                hx = nx
                ' keep it a unit vector (the small-angle rotation drifts slightly)
                l = Sqr(hx * hx + hy * hy)
                hx = hx / l
                hy = hy / l
            end if
            c.hx = hx
            c.hy = hy
        end if
    end if
    x = c.x + vx * dt
    if x >= 72 then
        x = x - 72
    else if x < 0 then
        x = x + 72
    end if
    c.x = x
    y = c.y + vy * dt
    c.y = y
    clr = c.clear - sp2 * dt - 0.004
    if clr < 0.2 then
        rr = w.rr
        L = c.length
        if c.isPlayer or c.hiddenIn >= 0 then
            TerrCollisionLength(rr, x, y, L)
            L = m.tcl
        end if
        TerrResolve(rr, c, c.radius, L)
        if m.thit then
            clr = 0.0
        else
            clr = m.td - c.radius
        end if
    else
        top = 40.35 - c.radius * 0.5
        if y > top then
            c.y = top
            if vy > 0 then c.vy = vy * -0.2
        end if
    end if
    c.clear = clr
    c.speedNorm = sp2 * sp.invswim

    if c.isPlayer then
        UpdateVisibility(w, c)
        return
    end if
    ' ---- stuck detection: an animal that wants to move but makes no progress picks a new path
    if now - c.stuckAt > 4 then
        moved = Dist(c.x, c.y, c.progX, c.progY)
        b = c.behavior
        if moved < 0.4 and (c.steerX * c.steerX + c.steerY * c.steerY) > 0.16 and b <> 10 and b <> 5 and b <> 7 then
            if b = 3 or b = 2 then
                GiveUpHunt(w, c)
            else
                PickWaypoint(w, c)
                if c.school <> invalid then
                    c.school.x = c.wanderX
                    c.school.y = c.wanderY
                end if
            end if
            if TerrSdfFor(w.rr, c.x, c.y, c.length) < c.radius then c.y = c.y + 0.5
        end if
        c.stuckAt = now
        c.progX = c.x
        c.progY = c.y
    end if
    c.visN = c.visN + 1
    if c.visN >= 3 then
        c.visN = 0
        UpdateVisibility(w, c)
    end if
end sub

sub IntegrateCrawler(w as object, c as object, dt as float)
    sp = c.sp
    surf = c.surface
    b = c.behavior
    speed = 0.0
    if b = 4 then
        speed = sp.swim * 2.2
    else if b = 11 then
        speed = sp.swim * (0.6 + 0.4 * w.actLv[sp.act])
    end if
    if w.time < c.stunUntil then speed = 0.0
    if sp.mv = 1 and sp.cleaner <> "" then speed = 0.0
    rr = w.rr
    if surf = invalid then
        ' fell off: drop to the seabed
        c.vy = c.vy - 3 * dt
        c.y = c.y + c.vy * dt
        TerrResolve(rr, c, c.radius, c.length)
        return
    end if
    if speed = 0 then
        c.vx = 0.0
        c.vy = 0.0
        c.speedNorm = 0.0
        return
    end if
    ' surfaces can straddle the wrap seam: work in the surface's own frame
    x0 = surf.x0
    fx = c.x - x0
    if fx < 0 then
        fx = fx + 72
    else if fx >= 72 then
        fx = fx - 72
    end if
    fx = x0 + fx + c.crawlDir * speed * dt
    if fx > surf.x1 then
        fx = surf.x1
        c.crawlDir = -1
    else if fx < x0 then
        fx = x0
        c.crawlDir = 1
    end if
    x = fx
    if x >= 72 then
        x = x - 72
    else if x < 0 then
        x = x + 72
    end if
    ' height of the surface here (sampled heights, linear in between)
    span = surf.x1 - x0
    if span < 0.001 then span = 0.001
    ys = surf.ys
    ny = ys.Count() - 1
    f = (fx - x0) / span * ny
    iy = Int(f)
    if iy >= ny then
        sy = ys[ny]
    else
        sy = ys[iy] + (ys[iy + 1] - ys[iy]) * (f - iy)
    end if
    y = sy + c.radius * 0.8 + 0.04
    ' surfaces can run under overhangs: turn back rather than crawl into rock
    g = rr.grid
    ix = Int(x * 4.0 + 0.5) MOD 288
    gy = Int(y * 4.0 + 0.5)
    if gy > 162 then gy = 162
    ahead = (g[gy * 289 + ix] - 128) * 0.04
    if ahead < c.radius * 0.3 then
        ix = Int(c.x * 4.0 + 0.5) MOD 288
        gy = Int(c.y * 4.0 + 0.5)
        if gy > 162 then gy = 162
        if ahead < (g[gy * 289 + ix] - 128) * 0.04 then
            c.crawlDir = -c.crawlDir
            c.vx = 0.0
            c.vy = 0.0
            c.speedNorm = 0.0
            return
        end if
    end if
    dx = x - c.x
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    c.vx = dx / dt
    c.vy = (y - c.y) / dt
    c.x = x
    c.y = y
    c.groundY = y - c.radius * 0.8 - 0.04
    if c.crawlDir > 0 then
        c.hx = 1.0
    else
        c.hx = -1.0
    end if
    c.hy = 0.0
    c.speedNorm = speed * sp.invswim
end sub

' Coarse movement for a swimmer outside the simulated bubble: glide toward its waypoint and
' choose a new one on arrival. No collision (it is far out of sight); WorldWake repairs positions.
sub BrainDormant(w as object, rr as object, c as object, ddt as float)
    now = w.time
    c.dormAt = now
    sp = c.sp
    if sp.cleaner <> "" or sp.ambush then return
    if c.behavior = 7 then return
    tx = c.wanderX
    ty = c.wanderY
    st = c.school
    if st <> invalid then
        tx = st.x + (c.seed MOD 7 - 3) * 0.25
        ty = st.y + (c.seed MOD 5 - 2) * 0.2
    end if
    dx = tx - c.x
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    dy = ty - c.y
    d = Sqr(dx * dx + dy * dy)
    stepLen = sp.swim * 0.5 * ddt
    if sp.mv = 4 then stepLen = 0.35 * ddt
    if d <= stepLen or d < 0.8 then
        ' arrived: choose the next waypoint inside the species' home range
        rng = w.rng
        sector = c.homeSector
        if sp.patroller then
            if Rnd(0) < 0.55 then
                col = (sector MOD 3) + Int(Rnd(0) * 3) - 1
                row = sp.rows[Int(Rnd(0) * sp.rows.Count())]
                sector = row * 3 + ((col MOD 3) + 3) MOD 3
            end if
        end if
        for i = 0 to 3
            pt = SampleOpenPoint(rr, sector, rng, c.radius + 0.4, sp.blo, sp.bhi)
            if pt <> invalid then
                c.wanderX = pt.x
                c.wanderY = pt.y
                if st <> invalid then
                    if now > st.until then
                        st.x = pt.x
                        st.y = pt.y
                        st.until = now + 10
                    end if
                end if
                exit for
            end if
        end for
        return
    end if
    c.x = WrapX(c.x + dx / d * stepLen)
    c.y = c.y + dy / d * stepLen
    c.px = c.x
    c.py = c.y
    if dx >= 0 then
        c.hx = 1.0
        c.face = 1.0
        c.faceTo = 1.0
    else
        c.hx = -1.0
        c.face = -1.0
        c.faceTo = -1.0
    end if
    c.hy = 0.0
    c.simAt = now
    c.pAt = now
    c.sector = SectorOf(c.x, c.y)
end sub
