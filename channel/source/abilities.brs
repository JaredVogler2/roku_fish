' ============================================================================
' abilities.brs - special abilities with real effects on perception, feeding and movement.
' Shared by the player and NPCs (cuttlefish ink, electric rays pulse, puffers inflate ...).
' Ported from the web game's systems/abilities.ts.
' ============================================================================

function AbilityReady(c as object, id as string, now as float) as boolean
    if id = "none" or id = "" then return false
    return CooldownLeft(c, id, now) <= 0
end function

sub AbilityEnd(w as object, c as object, id as string)
    if c.ab.DoesExist(id) then
        c.ab.Delete(id)
        c.abCount = c.abCount - 1
        if id = "inflate" then c.inflated = false
        if c.isPlayer then w.playerVersion = w.playerVersion + 1
    end if
end sub

function AbilityActivate(w as object, c as object, id as string) as boolean
    if id = "none" or id = "" or not c.alive then return false
    def = m.abilities[id]
    if def = invalid then return false
    now = w.time
    ' toggles switch off when pressed again
    if def.toggle and c.ab.DoesExist(id) then
        AbilityEnd(w, c, id)
        return true
    end if
    if CooldownLeft(c, id, now) > 0 then return false
    if c.isPlayer and not w.cfg.infiniteEnergy then
        if c.energy < def.energycost + 1 then
            WorldFeedback(w, "Too exhausted for " + def.name + ".")
            return false
        end if
        c.energy = c.energy - def.energycost
    end if
    c.cd[id] = now + def.cooldown
    if def.duration > 0 then
        if not c.ab.DoesExist(id) then c.abCount = c.abCount + 1
        c.ab[id] = now + def.duration
        if id = "inflate" then c.inflated = true
        ' register for the per-tick upkeep
        found = false
        for each u in w.abilityUsers
            if u.id = c.id then found = true
        end for
        if not found then w.abilityUsers.Push(c)
    end if
    if c.isPlayer then w.playerVersion = w.playerVersion + 1
    hx = c.hx
    hy = c.hy
    cid = c.id

    if id = "inkCloud" then
        ix = c.x - hx * c.length * 0.6
        iy = c.y - hy * c.length * 0.6
        WorldAddEffect(w, "ink", ix, iy, 2.2 + c.length, def.duration, cid)
        w.inkCount = w.inkCount + 1
        c.burstUntil = now + 0.9
        for each o in w.act
            if o.id <> cid and o.alive then
                if Dist(c.x, c.y, o.x, o.y) <= 9 then
                    if o.targetId = cid or (o.lunging and o.lungeTargetId = cid) then
                        o.inkUntil = now + 2.6
                        o.lunging = false
                        o.lastSeenX = ix
                        o.lastSeenY = iy
                        o.lastSeenAt = now - 1
                        o.behavior = 13
                        o.bsince = now
                    else if Dist(o.x, o.y, ix, iy) < 2.5 then
                        o.inkUntil = now + 1.5
                    end if
                end if
            end if
        end for
    else if id = "electricPulse" then
        R = 2.2 + c.length * 0.5
        WorldAddEffect(w, "pulse", c.x, c.y, R, 0.6, cid)
        for each o in w.act
            if o.id <> cid and o.alive and o.sp.mobile then
                d = Dist(c.x, c.y, o.x, o.y)
                if d <= R then
                    big = (o.length > c.length * 3)
                    st = 1.7
                    if big then st = 0.6
                    st = st * (1 - (d / R) * 0.4)
                    if o.stunUntil < now + st then o.stunUntil = now + st
                    o.lunging = false
                    if big then
                        AbilityPush(c, o, 1.5)
                    else
                        AbilityPush(c, o, 3.5)
                    end if
                    if o.targetId = cid then AbilityDisengage(w, o, c)
                    if not o.isPlayer then WorldDamage(w, o, 6, "stung", c.sp.id, false)
                end if
            end if
        end for
    else if id = "sting" then
        reach = 1.2 + c.length * 1.2
        WorldAddEffect(w, "sting", c.x - hx * c.length * 0.8, c.y - hy * c.length * 0.8, reach * 0.6, 0.35, cid)
        for each o in w.act
            if o.id <> cid and o.alive and o.sp.mobile then
                dx = DxWrap(c.x, o.x)
                dy = o.y - c.y
                d = Sqr(dx * dx + dy * dy)
                if d <= reach then
                    if d < 0.001 then d = 1.0
                    ' only what is behind (the tail side)
                    if (dx * hx + dy * hy) / d <= -0.2 then
                        WorldDamage(w, o, 20, "stung", c.sp.id, false)
                        o.venom = o.venom + 2
                        if o.stunUntil < now + 0.5 then o.stunUntil = now + 0.5
                        o.lunging = false
                        AbilityPush(c, o, 2.5)
                        if o.targetId = cid then AbilityDisengage(w, o, c)
                    end if
                end if
            end if
        end for
    else if id = "sonicBurst" then
        R = 4 + c.length
        WorldAddEffect(w, "sonic", c.x, c.y, R, 0.7, cid)
        for each o in w.act
            if o.id <> cid and o.alive and o.sp.mobile then
                if Dist(c.x, c.y, o.x, o.y) <= R then
                    if (o.sp.schooling or o.length < c.length * 0.5) and not o.isPlayer then
                        o.behavior = 4
                        o.bsince = now
                        o.threatId = cid
                        o.calmUntil = now + 2
                        o.wanderOk = false
                    end if
                    if o.targetId = cid then AbilityDisengage(w, o, c)
                    if o.length >= c.length * 0.5 then
                        if o.stunUntil < now + 0.8 then o.stunUntil = now + 0.8
                    end if
                    AbilityPush(c, o, 2.0)
                end if
            end if
        end for
    else if id = "burstSprint" then
        c.burstUntil = now + def.duration
        WorldAddEffect(w, "sprint", c.x, c.y, 0.6, 0.8, cid)
    else if id = "cleanerMimic" then
        WorldAddEffect(w, "mimic", c.x, c.y, 1.2, def.duration, cid)
    else if id = "lure" then
        WorldAddEffect(w, "lure", c.x + hx * c.length * 0.6, c.y + 0.2, 0.5, def.duration, cid)
    else if id = "defensiveSpines" then
        WorldAddEffect(w, "spines", c.x, c.y, c.length, 0.6, cid)
    end if
    WorldEmit(w, { ev: "ABILITY_USED", entityId: cid, isPlayer: c.isPlayer, ability: id, x: c.x, y: c.y })
    return true
end function

sub AbilityPush(src as object, o as object, impulse as float)
    dx = DxWrap(src.x, o.x)
    dy = o.y - src.y
    d = Sqr(dx * dx + dy * dy)
    if d < 0.001 then d = 1.0
    o.vx = o.vx + dx / d * impulse
    o.vy = o.vy + dy / d * impulse
end sub

sub AbilityDisengage(w as object, hunter as object, prey as object)
    hunter.ignoreId = prey.id
    hunter.ignoreUntil = w.time + 8
    hunter.targetId = -1
    hunter.behavior = 0
    hunter.bsince = w.time
    if prey.isPlayer then
        ps = w.ps
        key = hunter.id.ToStr()
        if ps.chasedBy.DoesExist(key) then
            ps.chasedBy.Delete(key)
            ps.chasedCount = ps.chasedCount - 1
            WorldEmit(w, { ev: "PREDATOR_LOST", predatorId: hunter.id, speciesId: hunter.sp.id })
            ps.escapes = ps.escapes + 1
        end if
    end if
end sub

' Per-tick upkeep of running abilities (expiry, energy drain, the lure).
sub AbilitiesUpdate(w as object, dt as float)
    users = w.abilityUsers
    n = users.Count()
    if n = 0 then return
    now = w.time
    i = n - 1
    while i >= 0
        c = users[i]
        drop = false
        if c.removed or not c.alive then
            drop = true
        else if c.abCount <= 0 then
            drop = true
        else
            expired = []
            ab = c.ab
            for each key in ab
                if now >= ab[key] then
                    expired.Push(key)
                else
                    def = m.abilities[key]
                    if def <> invalid then
                        if def.drainpersec > 0 and c.isPlayer and not w.cfg.infiniteEnergy then c.energy = c.energy - def.drainpersec * dt
                    end if
                    if key = "lure" and w.tick MOD 8 = 0 then AbilityLureTick(w, c)
                end if
            end for
            for each key in expired
                AbilityEnd(w, c, key)
            end for
            if c.abCount <= 0 then drop = true
        end if
        if drop then users.Delete(i)
        i = i - 1
    end while
end sub

' Lure: smaller eligible prey drift toward the lure; bigger hunters may notice it too.
sub AbilityLureTick(w as object, c as object)
    lx = c.x + c.hx * c.length * 0.7
    ly = c.y + 0.25
    now = w.time
    N = m.speciesBase
    cid = c.id
    for each o in w.act
        if o.id <> cid and o.alive and o.sp.mobile and not o.isPlayer then
            d = Dist(c.x, c.y, o.x, o.y)
            if d <= 9 then
                b = o.behavior
                if d <= 7 and b <> 4 and b <> 3 and o.length < c.length then
                    edible = false
                    if c.isPlayer then
                        if o.pvStamp <> w.playerVersion then BrainRefreshPv(w, o, c)
                        edible = o.pvEdible
                    else if c.sidx < N and o.sidx < N then
                        edible = (m.eatMode[c.sidx * N + o.sidx] > 0)
                    end if
                    if edible then
                        o.behavior = 0
                        o.bsince = now
                        o.wanderX = lx
                        o.wanderY = ly
                        o.wanderOk = true
                    end if
                else if o.length >= c.length * 1.5 and (b = 0 or b = 1) then
                    ' backfire: larger predators become curious
                    o.wanderX = c.x
                    o.wanderY = c.y
                    o.wanderOk = true
                    if o.hungryAt > now then o.hungryAt = now
                end if
            end if
        end if
    end for
end sub
