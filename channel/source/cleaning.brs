' ============================================================================
' cleaning.brs - cleaning stations.
' Bluestreak cleaner wrasse work by day and banded coral shrimp by night; a fish that holds still
' beside an open station is healed and has venom cleansed (web game's systems/cleaning.ts).
' ============================================================================

' Cleaners on duty at a station right now (list of creatures).
function CleaningActiveCleaners(w as object, st as object) as object
    out = []
    ph = w.phase
    for each o in w.act
        if o.alive and o.sp.cleaner <> "" then
            if Dist(st.x, st.y, o.x, o.y) <= 3 then
                cact = 0
                if o.sp.cleaner = "day" then
                    cact = 1
                else if o.sp.cleaner = "night" then
                    cact = 2
                end if
                if IsActive(cact, ph) then out.Push(o)
            end if
        end if
    end for
    return out
end function

function CleaningClosedReason(st as object) as string
    hasWrasse = (st.kind <> "night")
    hasShrimp = (st.kind <> "day")
    if hasWrasse and not hasShrimp then return "The cleaner wrasse are sheltering for the night. Come back after dawn, or find a banded coral shrimp station."
    if hasShrimp and not hasWrasse then return "Banded coral shrimp only clean at night. Come back after dusk, or find a cleaner wrasse by day."
    return "No cleaners are on duty here right now - they may have been scared off. Try again soon."
end function

sub CleaningUpdate(w as object, dt as float)
    rr = w.rr
    stations = rr.stations
    if stations.Count() = 0 then return
    p = w.player
    if p <> invalid then
        if p.alive then CleaningClient(w, p, dt, stations)
    end if
    ' (called every third tick) NPCs visiting a cleaner are served every twelfth tick
    if w.tick MOD 12 = 0 then
        act = w.act
        n = act.Count()
        for i = 0 to n - 1
            c = act[i]
            if c.alive and c.behavior = 14 then CleaningClient(w, c, dt * 4, stations)
        end for
    end if
end sub

sub CleaningClient(w as object, c as object, dt as float, stations as object)
    near = invalid
    reach = 1.6 + c.length * 0.5
    r2 = reach * reach
    cx = c.x
    cy = c.y
    for each st in stations
        dx = st.x - cx
        if dx > 36 then
            dx = dx - 72
        else if dx < -36 then
            dx = dx + 72
        end if
        dy = st.y - cy
        if dx * dx + dy * dy < r2 then
            near = st
            exit for
        end if
    end for
    if near = invalid then
        if c.isPlayer and c.cleanStation >= 0 then w.cleanNotified.Delete(c.cleanStation.ToStr())
        c.cleanT = 0.0
        c.cleanStation = -1
        return
    end if
    cleaners = CleaningActiveCleaners(w, near)
    if cleaners.Count() = 0 then
        if c.isPlayer then
            key = near.id.ToStr()
            if not w.cleanNotified.DoesExist(key) then
                w.cleanNotified[key] = true
                reason = CleaningClosedReason(near)
                WorldEmit(w, { ev: "CLEANER_UNAVAILABLE", isPlayer: true, stationId: near.id, reason: reason })
                WorldFeedback(w, reason)
            end if
        end if
        c.cleanStation = near.id
        c.cleanT = 0.0
        return
    end if
    speed = Sqr(c.vx * c.vx + c.vy * c.vy)
    if speed > 1.2 + c.length * 0.3 then
        c.cleanT = c.cleanT - dt
        if c.cleanT < 0 then c.cleanT = 0.0
        return
    end if
    first = (c.cleanT = 0)
    if c.isPlayer then
        c.cleanT = c.cleanT + dt
    else
        c.cleanT = c.cleanT + dt * 2
    end if
    c.cleanStation = near.id
    ' the cleaners dance over to the client
    now = w.time
    for each cl in cleaners
        cl.wanderX = c.x + Sin(now * 3 + cl.id) * c.length * 0.4
        cl.wanderY = c.y + Cos(now * 2.3 + cl.id) * c.length * 0.25
        cl.wanderOk = true
        cl.bsince = now
    end for
    if first and c.isPlayer then
        WorldEmit(w, { ev: "CLEANING_STARTED", targetId: c.id, isPlayer: true, cleaner: cleaners[0].sp.id, stationId: near.id })
    end if
    if c.cleanT < 0.8 then return
    if w.cfg.rules = "classicAccuracy" then
        heal = (c.maxHealth / 3.0) * dt
    else
        heal = 30.0 * dt
    end if
    before = c.health
    c.health = c.health + heal
    if c.health > c.maxHealth then c.health = c.maxHealth
    c.venom = c.venom - 1.5 * dt
    if c.venom < 0 then c.venom = 0.0
    c.wound = c.wound - dt * 0.3
    if c.wound < 0 then c.wound = 0.0
    gained = c.health - before
    if gained > 0 and c.isPlayer then
        w.ps.healed = w.ps.healed + gained
        if w.tick MOD 15 = 0 then
            WorldEmit(w, { ev: "HEALED", targetId: c.id, isPlayer: true, amount: gained * 12 })
            WorldAddEffect(w, "heal", c.x, c.y, 0.8, 0.8, c.id)
        end if
    end if
end sub
