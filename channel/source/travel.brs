' ============================================================================
' travel.brs - reef passes between regions.
' Crossing an unlocked pass swaps the active region; the region you leave keeps its populations.
' ============================================================================

sub TravelCheckPasses(w as object)
    p = w.player
    if p = invalid then return
    if (not p.alive) or w.time < w.regionCooldownUntil then return
    for each pass in w.rr.passes
        if Dist(p.x, p.y, pass.x, pass.y) <= pass.r then
            if not w.cfg.unlocked.DoesExist(pass.dest) then
                if w.time - w.lockedNoticeAt > 6 then
                    w.lockedNoticeAt = w.time
                    if w.cfg.growthMode then
                        hint = "Grow larger to brave the currents of this reef pass."
                    else
                        hint = "Advance further in this mode to unlock this reef pass."
                    end if
                    WorldEmit(w, { ev: "PASS_LOCKED", dest: pass.dest, hint: hint })
                    WorldFeedback(w, "The current is too strong. " + hint)
                end if
                return
            end if
            TravelChangeRegion(w, pass.dest)
            return
        end if
    end for
end sub

sub TravelChangeRegion(w as object, toId as string)
    p = w.player
    fromId = w.rr.id
    if fromId = toId then return
    ' Take the player out of the old region; pursuers lose the trail.
    old = w.rr
    keep = []
    for each c in old.creatures
        if c.id <> p.id then keep.Push(c)
    end for
    old.creatures = keep
    ps = w.ps
    for each key in ps.chasedBy
        c = WorldGet(w, key.ToInt())
        if c <> invalid then
            c.targetId = -1
            c.behavior = 0
        end if
    end for
    ps.chasedBy = {}
    ps.chasedCount = 0
    ps.targetId = -1
    WorldActivateRegion(w, toId)
    rr = w.rr
    back = invalid
    for each q in rr.passes
        if q.dest = fromId then back = q
    end for
    if back = invalid and rr.passes.Count() > 0 then back = rr.passes[0]
    x = 12.0
    y = 30.0
    if back <> invalid then
        x = back.x + 2.2
        y = back.y + 0.6
    end if
    p.x = x
    p.y = y
    p.vx = 1.0
    p.vy = 0.0
    for i = 0 to 29
        if TerrSdf(rr, p.x, p.y) >= p.radius + 0.3 then exit for
        p.y = p.y + 0.4
    end for
    p.px = p.x
    p.py = p.y
    p.simAt = w.time
    p.pAt = w.time
    p.hiddenIn = -1
    p.sector = SectorOf(p.x, p.y)
    p.active = true
    rr.creatures.Push(p)
    w.focusX = p.x
    w.focusY = p.y
    w.actDirty = true
    w.regionCooldownUntil = w.time + 3
    WorldDiscover(w, p.sp.id)
    WorldEmit(w, { ev: "REGION_CHANGED", src: fromId, dest: toId })
end sub
