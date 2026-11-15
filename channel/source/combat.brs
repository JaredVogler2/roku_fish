' ============================================================================
' combat.brs - lunges and what happens on contact.
' Bites land only on real mouth contact during a lunge, and every outcome emits an event with a
' reason (ported from the web game's systems/combat.ts).
' ============================================================================

function CombatStartLunge(w as object, c as object, target as object) as boolean
    now = w.time
    if now < c.lungeReadyAt or c.lunging or not c.alive then return false
    c.lunging = true
    c.lungeUntil = now + 0.32
    c.lungeTargetId = target.id
    c.attackAt = now
    dx = DxWrap(c.x, target.x)
    dy = target.y - c.y
    d = Sqr(dx * dx + dy * dy)
    if d < 0.001 then d = 1.0
    dx = dx / d
    dy = dy / d
    boost = c.sp.burst * 1.35 * 0.8
    along = c.vx * dx + c.vy * dy
    if along < boost then
        c.vx = c.vx + dx * (boost - along) * 0.6
        c.vy = c.vy + dy * (boost - along) * 0.6
    end if
    if c.isPlayer then
        if not w.cfg.infiniteEnergy then
            mass = c.mass
            if mass < 0.2 then mass = 0.2
            c.energy = c.energy - 1.2 * (mass ^ 0.25) * 0.6
        end if
        ' Classic rules: the prey freezes for an instant before the chomp.
        if w.classicChomp and target.sp.mobile and not target.isPlayer then target.freezeUntil = now + 0.28
    end if
    return true
end function

sub CombatUpdateLunge(w as object, c as object, dt as float)
    now = w.time
    t = WorldGet(w, c.lungeTargetId)
    alive = false
    if t <> invalid then alive = t.alive
    if not alive then
        c.lunging = false
        c.lungeReadyAt = now + 0.5 * c.mLungeCd * 0.5
        return
    end if
    dx = DxWrap(c.x, t.x)
    dy = t.y - c.y
    d = Sqr(dx * dx + dy * dy)
    if d < 0.001 then d = 1.0
    sp = c.sp.burst * 1.35
    c.steerX = dx / d * sp
    c.steerY = dy / d * sp
    c.wantBurst = true
    reach = t.radius + c.length * 0.32 + 0.08
    mx = c.x + c.hx * c.length * 0.45
    my = c.y + c.hy * c.length * 0.45
    ' at 30 ticks a second a fast lunge covers a lot of ground per tick, so allow for the next step
    slack = Sqr(c.vx * c.vx + c.vy * c.vy) * dt * 0.5
    if Dist(mx, my, t.x, t.y) <= reach + slack or d <= reach * 0.8 then
        c.lunging = false
        CombatResolveContact(w, c, t)
        cdEnd = now + 0.5 * c.mLungeCd
        if cdEnd > c.lungeReadyAt then c.lungeReadyAt = cdEnd
        return
    end if
    if now >= c.lungeUntil then
        c.lunging = false
        c.lungeReadyAt = now + 0.5 * c.mLungeCd
        WorldEmit(w, { ev: "ATTACK_MISSED", attackerId: c.id, targetId: t.id, isPlayer: c.isPlayer, x: c.x, y: c.y })
        if c.isPlayer then
            w.ps.misses = w.ps.misses + 1
            if t.hiddenIn >= 0 then
                WorldFeedback(w, "Missed - the " + t.sp.name + " ducked into cover.")
            else
                WorldFeedback(w, "Missed - the " + t.sp.name + " dodged!")
            end if
        end if
        if t.isPlayer then w.ps.escapes = w.ps.escapes + 1
    end if
end sub

sub CombatResolveContact(w as object, a as object, t as object)
    now = w.time
    ms = WorldMilestone(w, a)
    mimic = false
    if a.abCount > 0 then mimic = a.ab.DoesExist("cleanerMimic")
    CheckFeed(w, a, t, ms, false, true, mimic)
    f = m.fc
    result = f.result
    reason = f.reason
    spine = f.spine
    toxin = f.toxin
    a.biteAt = now
    ps = w.ps
    if result = "SWALLOW" or result = "BITE" then
        if t.isPlayer then
            CombatPredatorHitsPlayer(w, a, t, result = "SWALLOW")
        else
            CombatApplyMeal(w, a, t, result = "SWALLOW")
        end if
        if mimic and a.isPlayer then AbilityEnd(w, a, "cleanerMimic")
        if spine > 0 then
            WorldDamage(w, a, spine, "spines", t.sp.id, false)
            WorldAddEffect(w, "spines", t.x, t.y, 0.8, 0.5, t.id)
        end if
    else if result = "HARMFUL_BITE" then
        WorldDamage(w, a, toxin, "poisoned", t.sp.id, false)
        a.venom = a.venom + Int(t.sp.tox * 3 + 0.5)
        WorldEmit(w, { ev: "HARMFUL_BITE", attackerId: a.id, targetId: t.id, speciesId: t.sp.id, isPlayer: a.isPlayer, damage: toxin, reason: reason, x: t.x, y: t.y })
        WorldAddEffect(w, "poison", a.x, a.y, 0.9, 1.2, a.id)
        if a.isPlayer then
            ps.toxicMistakes = ps.toxicMistakes + 1
            WorldFeedback(w, reason + " You spit it out.")
            WorldDiscover(w, t.sp.id)
        else
            a.ignoreId = t.id
            a.ignoreUntil = now + 60
            a.targetId = -1
            a.behavior = 0
            a.bsince = now
        end if
        if t.sp.mobile then CombatFleeFrom(w, t, a)
    else if result = "REPELLED" then
        if spine > 0 then WorldDamage(w, a, spine, "spines", t.sp.id, false)
        WorldAddEffect(w, "spines", t.x, t.y, 0.9, 0.5, t.id)
        ' knock the attacker back
        dx = DxWrap(t.x, a.x)
        dy = a.y - t.y
        d = Sqr(dx * dx + dy * dy)
        if d < 0.001 then d = 1.0
        a.vx = dx / d * 2.5
        a.vy = dy / d * 2.5
        WorldEmit(w, { ev: "FEED_REJECTED", attackerId: a.id, targetId: t.id, speciesId: t.sp.id, isPlayer: a.isPlayer, result: result, reason: reason, x: t.x, y: t.y })
        if a.isPlayer then
            WorldFeedback(w, reason)
        else
            a.ignoreId = t.id
            a.ignoreUntil = now + 25
            a.targetId = -1
            a.behavior = 0
            a.bsince = now
            if t.isPlayer then
                key = a.id.ToStr()
                if ps.chasedBy.DoesExist(key) then
                    ps.chasedBy.Delete(key)
                    ps.chasedCount = ps.chasedCount - 1
                    WorldEmit(w, { ev: "PREDATOR_LOST", predatorId: a.id, speciesId: a.sp.id })
                    ps.escapes = ps.escapes + 1
                end if
            end if
        end if
    else
        WorldEmit(w, { ev: "FEED_REJECTED", attackerId: a.id, targetId: t.id, speciesId: t.sp.id, isPlayer: a.isPlayer, result: result, reason: reason, x: t.x, y: t.y })
        if a.isPlayer then
            WorldFeedback(w, reason)
        else
            a.ignoreId = t.id
            a.ignoreUntil = now + 12
            a.targetId = -1
        end if
    end if
end sub

sub CombatFleeFrom(w as object, prey as object, threat as object)
    if prey.isPlayer or not prey.sp.mobile then return
    prey.threatId = threat.id
    prey.behavior = 4
    prey.bsince = w.time
    prey.calmUntil = w.time + 2
    prey.wanderOk = false
end sub

sub CombatPredatorHitsPlayer(w as object, a as object, p as object, swallow as boolean)
    if w.cfg.invulnerable then return
    now = w.time
    if now < p.invulnUntil then return
    dmg = BiteDamage(a, p, w.diff.damage)
    if p.abCount > 0 then
        if p.ab.DoesExist("defensiveSpines") then dmg = dmg * 0.4
    end if
    if p.hiddenIn >= 0 then dmg = dmg * 0.8
    if a.hungryAt < now + 4 then a.hungryAt = now + 4
    if a.lungeReadyAt < now + 1.1 then a.lungeReadyAt = now + 1.1
    if p.health - dmg <= 0 then
        if swallow then
            WorldKill(w, p, "eaten", a.sp.id, false)
        else
            WorldKill(w, p, "bitten", a.sp.id, false)
        end if
        a.hungryAt = now + 30
        a.targetId = -1
        return
    end if
    WorldDamage(w, p, dmg, "bitten", a.sp.id, false)
    WorldAddEffect(w, "chomp", p.x, p.y, 0.8, 0.4, a.id)
    ' knock-back and an adrenaline burst so a bitten fish can escape
    dx = DxWrap(a.x, p.x)
    dy = p.y - a.y
    d = Sqr(dx * dx + dy * dy)
    if d < 0.001 then d = 1.0
    p.vx = p.vx + dx / d * 3
    p.vy = p.vy + dy / d * 3
    p.burstUntil = now + 0.8
    WorldFeedback(w, "Bitten by a " + a.sp.name + "! Get to cover.")
end sub

sub CombatApplyMeal(w as object, a as object, t as object, swallow as boolean)
    now = w.time
    energy = MealEnergy(a, t, swallow)
    biomass = MealBiomass(t, swallow)
    consumed = false
    resource = (t.maxCharges > 0)
    ' Classic Accuracy: unlimited repeat nibbling of plankton / algae-like food, as in the original.
    classicInfinite = (w.cfg.rules = "classicAccuracy" and a.isPlayer and t.sp.plantlike)
    if resource then
        if swallow then
            consumed = true
        else
            CreatureCharges(t, now)
            if not classicInfinite then
                if t.charges >= t.maxCharges then t.chargeAt = now
                t.charges = t.charges - 1
            end if
            consumed = (t.charges <= 0)
        end if
    else if not swallow then
        dmg = BiteDamage(a, t, 1.0) * 0.8
        t.health = t.health - dmg
        t.hurtAt = now
        t.wound = ClampF(t.wound + 0.3, 0.0, 1.0)
        consumed = (t.health <= 0)
        if not consumed then CombatFleeFrom(w, t, a)
    else
        consumed = true
    end if
    if consumed then WorldKill(w, t, "eaten", a.sp.id, true)
    t.biteAt = now

    if a.isPlayer then
        PlayerAte(w, t, swallow, consumed, energy, biomass)
    else
        frac = energy / 28.0
        if frac < 0.25 then frac = 0.25
        if frac > 1 then frac = 1.0
        sat = RngRange(w.rng, 18, 40) * frac
        if resource then sat = sat * 0.35
        a.hungryAt = now + sat
        a.health = a.health + energy * 0.3
        if a.health > a.maxHealth then a.health = a.maxHealth
        if consumed then a.targetId = -1
        etype = "FOOD_BITE"
        if consumed then etype = "FOOD_CONSUMED"
        WorldEmit(w, { ev: etype, attackerId: a.id, targetId: t.id, speciesId: t.sp.id, isPlayer: false, points: 0, energy: energy, mass: biomass, x: t.x, y: t.y })
    end if
    r = t.radius * 1.5
    if r < 0.4 then r = 0.4
    WorldAddEffect(w, "chomp", t.x, t.y, r, 0.35, a.id)
end sub
