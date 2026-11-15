' ============================================================================
' player.brs - the player's fish: remote input -> steering, chasing and biting, metabolism,
' growth and scoring. Ported from the web game's systems/player.ts.
'
' Roku controls: the D-pad swims. OK locks on to the best edible thing ahead; the fish then chases
' it by itself whenever the D-pad is released and lunges when in range (the web game's keyboard
' "bite" key works the same way). Replay steps through nearby creatures to inspect them; OK on an
' inspected creature tries to eat it even if it is risky - that is how you learn the reef.
' ============================================================================

sub PlayerSetTarget(w as object, id as integer)
    ps = w.ps
    ps.targetId = id
    ps.chaseBest = 9999.0
    ps.chaseProgressAt = w.time
    ps.awayT = 0.0
end sub

' Try to target a specific creature (inspected with Replay). Risky meals are allowed.
function PlayerSelectTarget(w as object, id as integer) as boolean
    p = w.player
    t = WorldGet(w, id)
    if p = invalid or t = invalid then return false
    if t.id = p.id then return false
    CheckFeed(w, p, t, WorldMilestone(w, p), true, false, false)
    f = m.fc
    WorldDiscover(w, t.sp.id)
    r = f.result
    if r = "SWALLOW" or r = "BITE" or r = "HARMFUL_BITE" or r = "REPELLED" then
        PlayerSetTarget(w, id)
        return true
    end if
    WorldFeedback(w, f.reason)
    WorldEmit(w, { ev: "FEED_REJECTED", attackerId: p.id, targetId: t.id, speciesId: t.sp.id, isPlayer: true, result: r, reason: f.reason, x: t.x, y: t.y })
    return false
end function

' Best edible thing ahead of the fish within maxD, or invalid.
function PlayerBestTarget(w as object, p as object, maxD as float) as dynamic
    best = invalid
    bestScore = 99999.0
    hx = p.hx
    hy = p.hy
    lim = maxD + p.length
    ver = w.playerVersion
    for each o in w.act
        if o.alive and not o.isPlayer then
            dx = DxWrap(p.x, o.x)
            dy = o.y - p.y
            if dx < lim and dx > -lim and dy < lim and dy > -lim then
                d = Sqr(dx * dx + dy * dy)
                if d <= lim then
                    if o.pvStamp <> ver then BrainRefreshPv(w, o, p)
                    if o.pvEdible then
                        ok = true
                        if o.maxCharges > 0 then ok = (CreatureCharges(o, w.time) > 0)
                        if ok and o.hiddenIn >= 0 then ok = (p.length <= w.rr.shelters[o.hiddenIn].clearance)
                        if ok then
                            score = d
                            if d > 0.001 then
                                if (dx * hx + dy * hy) / d <= 0 then score = d * 2.5
                            end if
                            if score < bestScore then
                                bestScore = score
                                best = o
                            end if
                        end if
                    end if
                end if
            end if
        end if
    end for
    return best
end function

' Next creature for the inspect card: nearest first, then outward (Replay button).
function PlayerNextInspect(w as object) as integer
    p = w.player
    if p = invalid then return -1
    ps = w.ps
    cur = WorldGet(w, ps.inspectId)
    curD = -1.0
    if cur <> invalid then curD = Dist(p.x, p.y, cur.x, cur.y)
    first = invalid
    firstD = 99999.0
    nxt = invalid
    nxtD = 99999.0
    for each o in w.act
        if o.alive and not o.isPlayer then
            d = Dist(p.x, p.y, o.x, o.y)
            if d < 9 then
                if d < firstD then
                    firstD = d
                    first = o
                end if
                if d > curD + 0.001 and d < nxtD then
                    nxtD = d
                    nxt = o
                end if
            end if
        end if
    end for
    if nxt = invalid then nxt = first
    if nxt = invalid then return -1
    WorldDiscover(w, nxt.sp.id)
    return nxt.id
end function

' Slide around rock instead of pressing into it while auto-chasing.
sub PlayerSteerAround(w as object, p as object, sx as float, sy as float, lookahead as float)
    m.psx = sx
    m.psy = sy
    sp = Sqr(sx * sx + sy * sy)
    if sp < 0.05 or lookahead < 0.3 then return
    rr = w.rr
    need = p.radius + 0.04
    L = lookahead
    if L > 0.7 + p.length then L = 0.7 + p.length
    TerrCollisionLength(rr, p.x, p.y, p.length)
    bodyL = m.tcl
    base = Atan2(sy, sx)
    side = w.ps.avoidSide
    for k = 0 to 8
        a = base
        if k > 0 then
            stepA = 0.45 * ((k + 1) \ 2)
            if k MOD 2 = 1 then
                a = base + stepA * side
            else
                a = base - stepA * side
            end if
        end if
        ca = Cos(a)
        sa = Sin(a)
        clear = true
        if TerrSdfFor(rr, WrapX(p.x + ca * L * 0.5), p.y + sa * L * 0.5, bodyL) < need then
            clear = false
        else if TerrSdfFor(rr, WrapX(p.x + ca * L), p.y + sa * L, bodyL) < need then
            clear = false
        end if
        if clear then
            if k > 0 then
                if k MOD 2 = 0 then w.ps.avoidSide = -side
                m.psx = ca * sp
                m.psy = sa * sp
            end if
            return
        end if
    end for
end sub

sub PlayerPruneChasers(w as object, p as object)
    ps = w.ps
    if ps.chasedCount <= 0 then return
    gone = []
    for each key in ps.chasedBy
        c = WorldGet(w, key.ToInt())
        still = false
        if c <> invalid then still = (c.alive and c.targetId = p.id)
        if not still then gone.Push(key)
    end for
    for each key in gone
        ps.chasedBy.Delete(key)
        ps.chasedCount = ps.chasedCount - 1
        c = WorldGet(w, key.ToInt())
        if c <> invalid then
            if c.alive then
                WorldEmit(w, { ev: "PREDATOR_LOST", predatorId: c.id, speciesId: c.sp.id })
                ps.escapes = ps.escapes + 1
            end if
        end if
    end for
end sub

sub PlayerUpdate(w as object, dt as float)
    p = w.player
    ps = w.ps
    inp = w.inp
    if not p.alive then
        p.steerX = 0.0
        p.steerY = 0.0
        return
    end if
    now = w.time
    rr = w.rr
    ps.timeAlive = ps.timeAlive + dt
    if w.tick MOD 6 = 0 then PlayerPruneChasers(w, p)

    if inp.ability then AbilityActivate(w, p, ps.primary)
    if inp.ability2 and ps.secondary <> "" then AbilityActivate(w, p, ps.secondary)
    if inp.inspect then ps.inspectId = PlayerNextInspect(w)

    target = WorldGet(w, ps.targetId)
    if target <> invalid then
        if not target.alive then target = invalid
    end if
    if target = invalid then ps.targetId = -1

    if inp.attack then
        picked = false
        ins = WorldGet(w, ps.inspectId)
        if ins <> invalid then
            ' OK on the inspected creature: try it, even if it is a risky meal
            if Dist(p.x, p.y, ins.x, ins.y) < 10 then
                if PlayerSelectTarget(w, ins.id) then target = ins
                picked = true
            end if
            ps.inspectId = -1
        end if
        if not picked then
            t = PlayerBestTarget(w, p, 3.6)
            if t <> invalid then
                PlayerSetTarget(w, t.id)
                target = t
            else if target = invalid then
                WorldFeedback(w, "Nothing edible within reach.")
                WorldEmit(w, { ev: "NO_TARGET" })
            end if
        end if
    end if

    ' ---------- movement
    cruise = p.sp.swim * p.mSpeed
    wantsSprint = (inp.sprint and p.energy > 4)
    sx = 0.0
    sy = 0.0
    mvx = inp.moveX
    mvy = inp.moveY
    kb = Sqr(mvx * mvx + mvy * mvy)
    manual = (kb > 0.12)
    if manual then
        sx = mvx / kb * cruise
        sy = mvy / kb * cruise
    end if
    if target <> invalid then
        d = Dist(p.x, p.y, target.x, target.y)
        if not manual then
            lead = d
            if p.sp.burst > 1 then lead = d / p.sp.burst
            if lead > 0.5 then lead = 0.5
            tx = target.x + target.vx * lead
            ty = target.y + target.vy * lead
            dx = DxWrap(p.x, tx)
            dy = ty - p.y
            l = Sqr(dx * dx + dy * dy)
            if l < 0.001 then l = 1.0
            if target.sp.mobile then
                spd = cruise * 1.15
            else
                spd = cruise * ClampF(l / 1.2, 0.35, 1.0)
            end if
            stopD = target.radius + p.length * 0.5
            PlayerSteerAround(w, p, dx / l * spd, dy / l * spd, d - stopD)
            sx = m.psx
            sy = m.psy
            if d < ps.chaseBest - 0.15 then
                ps.chaseBest = d
                ps.chaseProgressAt = now
            end if
        else
            ps.chaseProgressAt = now
            if d < ps.chaseBest then ps.chaseBest = d
            ' steering away from the prey for a moment lets go of it
            dx = DxWrap(p.x, target.x)
            dy = target.y - p.y
            if d > 0.001 then
                if (mvx * dx + mvy * dy) / (kb * d) < -0.3 then
                    ps.awayT = ps.awayT + dt
                else
                    ps.awayT = 0.0
                end if
            end if
        end if
        ' prey that slipped away, squeezed in where we cannot follow, or cannot be reached
        lost = ""
        lim = p.sp.perception * p.mPerception * 1.6
        if ps.chaseBest + 4 > lim then lim = ps.chaseBest + 4
        if d > lim then
            lost = "The " + target.sp.name + " got away."
        else if target.hiddenIn >= 0 then
            sh = rr.shelters[target.hiddenIn]
            if p.length > sh.clearance then lost = "The " + target.sp.name + " slipped into " + ShelterPhrase(sh.kind) + " too small for you."
        end if
        if lost = "" and now - ps.chaseProgressAt > 5 then lost = "Can't reach the " + target.sp.name + " from here - try another angle."
        if lost <> "" then
            WorldEmit(w, { ev: "PREY_ESCAPED", attackerId: p.id, targetId: target.id, isPlayer: true })
            WorldFeedback(w, lost)
            ps.targetId = -1
            target = invalid
        else if manual and ps.awayT > 0.7 then
            ps.targetId = -1
            target = invalid
        end if
    end if
    p.steerX = sx
    p.steerY = sy
    p.wantBurst = (wantsSprint and (sx * sx + sy * sy) > 0.04)

    ' auto-lunge when the target comes into range
    if target <> invalid then
        if (not p.lunging) and now >= p.lungeReadyAt then
            range = p.length * 1.1 + target.radius + 0.2
            if Dist(p.x, p.y, target.x, target.y) < range then CombatStartLunge(w, p, target)
        end if
    end if

    ' ---------- metabolism
    bm = m.bal.metabolism
    L = p.length
    if L < 0.2 then L = 0.2
    sizeF = ((L / 0.45) ^ 0.35) * p.mDrain * w.diff.drain
    speed = Sqr(p.vx * p.vx + p.vy * p.vy)
    cr = cruise
    if cr < 0.1 then cr = 0.1
    k = speed / cr
    if k > 1.2 then k = 1.2
    drain = 0.35 * sizeF + 0.45 * sizeF * k
    if p.wantBurst then drain = drain + 2.4 * p.mSprintDrain * Sqr(sizeF)
    if p.hiddenIn >= 0 and speed < 0.6 then drain = drain * 0.55
    if w.cfg.infiniteEnergy then
        p.energy = p.maxEnergy
    else
        p.energy = p.energy - drain * dt
    end if
    if p.energy <= 22 and not ps.lowEnergyWarned then
        ps.lowEnergyWarned = true
        WorldEmit(w, { ev: "LOW_ENERGY" })
        WorldFeedback(w, "Energy low - eat something soon!")
    end if
    if p.energy > 32 then ps.lowEnergyWarned = false
    if p.energy <= 0 then
        p.energy = 0.0
        WorldKill(w, p, "starved", "", false)
        return
    end if

    ' ---------- hiding
    if p.hiddenIn < 0 and w.tick MOD 60 = 0 then
        TerrCollisionLength(rr, p.x, p.y, p.length)
        if m.tcl < p.length then WorldFeedback(w, "You've outgrown this hiding spot - it no longer hides you. Find a bigger one.")
    end if
    ps.hidden = (p.hiddenIn >= 0 and p.visibility < 0.5)
    if ps.hidden then ps.hiddenTime = ps.hiddenTime + dt

    ' ---------- smooth visual growth
    g = p.length - p.vlen
    if g > 0.0001 or g < -0.0001 then
        k = dt / 0.21
        if k > 1 then k = 1.0
        p.vlen = p.vlen + g * k
    end if
    if p.length > ps.maxLength then ps.maxLength = p.length
end sub

' A successful player meal: energy, score (with anti-farming), growth and events.
sub PlayerAte(w as object, t as object, swallow as boolean, consumed as boolean, energy as float, biomass as float)
    p = w.player
    ps = w.ps
    now = w.time
    p.energy = p.energy + energy
    if p.energy > p.maxEnergy then p.energy = p.maxEnergy
    ' eating also mends a little (30 % of the meal's energy)
    p.health = p.health + energy * 0.3
    if p.health > p.maxHealth then p.health = p.maxHealth
    if swallow then
        ps.swallows = ps.swallows + 1
    else
        ps.bites = ps.bites + 1
    end if
    if consumed then
        ps.preyEaten = ps.preyEaten + 1
        ps.targetId = -1
    end if
    ' 1000 points for a swallow, 500 for a bite; Balanced rules stop farming of regrowing food
    points = 500
    if consumed then points = 1000
    plant = t.sp.plantlike
    if w.cfg.rules = "balanced" and (plant or t.maxCharges > 0) then
        if now - t.lastBittenAt > 40 then t.timesBitten = 0
        scale = [1.0, 0.5, 0.2, 0.0]
        i = t.timesBitten
        if i > 3 then i = 3
        points = Int(points * scale[i] + 0.5)
    end if
    t.timesBitten = t.timesBitten + 1
    t.lastBittenAt = now
    if points > 0 then
        ps.score = ps.score + points
        WorldEmit(w, { ev: "SCORE", delta: points, total: ps.score, x: t.x, y: t.y })
    end if
    ' growth (Reef Ascension)
    gain = 0.0
    if w.cfg.growthMode then
        factor = 1.0
        if plant then
            keep = []
            for each tt in ps.plantBites
                if now - tt < 30 then keep.Push(tt)
            end for
            factor = 1.0 / (1 + keep.Count() * 0.25)
            keep.Push(now)
            ps.plantBites = keep
        end if
        gain = biomass * 0.36 * factor
        before = ps.mass
        ps.mass = ps.mass + gain
        if ps.mass > 64 then ps.mass = 64.0
        WorldApplyGrowth(w, false)
        ms = MilestoneForMass(ps.mass)
        if ms > ps.milestone then
            ps.milestone = ms
            w.playerVersion = w.playerVersion + 1
            WorldEmit(w, { ev: "MILESTONE_REACHED", milestone: ms, name: m.bal.growth.milestonenames[ms], length: p.length })
        end if
        if ps.mass > before then WorldEmit(w, { ev: "GROWTH", mass: ps.mass, length: p.length })
    end if
    WorldDiscover(w, t.sp.id)
    etype = "FOOD_BITE"
    if consumed then etype = "FOOD_CONSUMED"
    WorldEmit(w, { ev: etype, attackerId: p.id, targetId: t.id, speciesId: t.sp.id, isPlayer: true, points: points, energy: energy, mass: gain, x: t.x, y: t.y })
end sub

' Field Guide discovery: species the player actually sees.
sub PlayerDiscovery(w as object)
    p = w.player
    if not p.alive then return
    r = p.sp.perception * 1.1 + 2
    if r > 9 then r = 9.0
    disc = w.discovered
    for each o in w.act
        if o.alive and not o.isPlayer then
            if not disc.DoesExist(o.sp.id) then
                d = Dist(p.x, p.y, o.x, o.y)
                if d <= r then
                    if CanSee(w, p, o, d) then WorldDiscover(w, o.sp.id)
                end if
            end if
        end if
    end for
end sub
