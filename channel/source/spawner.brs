' ============================================================================
' spawner.brs - population management.
' Authored population tables per sector create spawn slots; members that die are replaced after a
' delay (never instantly, never in view), and a viable-food guarantee prevents soft locks for any
' playable species. Ported from the web game's systems/spawner.ts.
' ============================================================================

sub SpawnerPopulate(w as object, rr as object)
    rng = RngNew(HashStr(w.cfg.seed + ":pop:" + rr.id))
    d = w.diff
    cfg = w.cfg
    si = 0
    for each sb in rr.sectors
        for each entry in sb.pop
            sp = GetSpecies(entry.sp)
            if sp <> invalid then
                count = 0
                if type(entry.n) = "roArray" then
                    count = RngInt(rng, entry.n[0], entry.n[1])
                else
                    count = entry.n
                end if
                if sp.predatorish then
                    mul = d.predatordensity * cfg.predatorMul
                    v = count * mul
                    base = Int(v)
                    count = base
                    if v - base > 0 then
                        if RngNext(rng) * 0.999 + (v - base) >= 1 then count = base + 1
                    end if
                    if cfg.tutorial and si <= 1 then count = 0
                else if sp.role = "hazard" then
                    count = Int(count * cfg.hazardMul + 0.5)
                else
                    count = Int(count * cfg.preyMul + 0.5)
                end if
                for g = 1 to count
                    size = 1
                    school = invalid
                    if entry.school <> invalid then
                        size = RngInt(rng, entry.school[0], entry.school[1])
                        school = { x: 0.0, y: 0.0, until: -1.0, members: [], id: w.schoolCounter }
                        w.schoolCounter = w.schoolCounter + 1
                    end if
                    lo = 0.9
                    hi = 1.1
                    if sp.playable then
                        lo = 0.85
                        hi = 1.12
                    end if
                    if entry.size <> invalid then
                        lo = entry.size[0]
                        hi = entry.size[1]
                    end if
                    slo = sp.slo
                    shi = sp.shi
                    if entry.band <> invalid then
                        bb = SpawnBand(entry.band)
                        slo = bb[0]
                        shi = bb[1]
                    end if
                    fb = (sp.band = "floor")
                    if entry.band <> invalid then fb = (entry.band = "floor")
                    slot = { sector: si, sp: sp, group: size, lo: lo, hi: hi, slo: slo, shi: shi, floorBand: fb, members: [], respawnAt: -1.0, kind: 0, fx: 0.0, fy: 0.0, school: school }
                    rr.slots.Push(slot)
                    SpawnSlot(w, rr, slot, rng, false)
                end for
            end if
        end for
        for each res in sb.res
            sp = GetSpecies(res.sp)
            if sp <> invalid then
                total = Int(res.n * d.foodabundance * cfg.preyMul + 0.5)
                for k = 1 to total
                    slot = { sector: si, sp: sp, group: 1, lo: 0.85, hi: 1.2, slo: sp.slo, shi: sp.shi, floorBand: (sp.band = "floor"), members: [], respawnAt: -1.0, kind: 1, fx: 0.0, fy: 0.0, school: invalid }
                    rr.slots.Push(slot)
                    SpawnSlot(w, rr, slot, rng, false)
                end for
            end if
        end for
        si = si + 1
    end for
    for each f in rr.fixed
        sp = GetSpecies(f.sp)
        if sp <> invalid then
            slot = { sector: f.s, sp: sp, group: 1, lo: 1.0, hi: 1.0, slo: sp.slo, shi: sp.shi, floorBand: false, members: [], respawnAt: -1.0, kind: 2, fx: f.x, fy: f.y, school: invalid }
            rr.slots.Push(slot)
            SpawnSlot(w, rr, slot, rng, false)
        end if
    end for
end sub

function SpawnBand(band as string) as object
    if band = "surface" then return [0.82, 0.97]
    if band = "high" then return [0.55, 0.95]
    if band = "mid" then return [0.3, 0.78]
    if band = "low" then return [0.1, 0.48]
    if band = "floor" then return [0.02, 0.28]
    return [0.06, 0.94]
end function

' Spawns every member of a slot. Returns false when no safe position was found.
function SpawnSlot(w as object, rr as object, slot as object, rng as object, avoidPlayer as boolean) as boolean
    sp = slot.sp
    if not SpawnPlace(w, rr, sp, slot.sector, slot.slo, slot.shi, slot.floorBand, slot.kind = 2, slot.fx, slot.fy, avoidPlayer, rng) then return false
    spot = m.spawnPos
    slot.members = []
    st = slot.school
    if st <> invalid then
        st.members = []
        st.x = spot.x
        st.y = spot.y
        st.until = -1.0
    end if
    for i = 0 to slot.group - 1
        size = RngRange(rng, slot.lo, slot.hi)
        x = spot.x
        y = spot.y
        if i > 0 then
            x = WrapX(spot.x + RngRange(rng, -1.2, 1.2))
            y = ClampF(spot.y + RngRange(rng, -0.8, 0.8), 0.5, 40.0)
            if TerrSdf(rr, x, y) < 0.3 then
                x = spot.x
                y = spot.y
            end if
        end if
        c = WorldAdd(w, sp, x, y, size, rr)
        c.slot = slot
        c.homeSector = slot.sector
        c.homeX = c.x
        c.homeY = c.y
        if st <> invalid then
            c.school = st
            st.members.Push(c)
            c.behavior = 1
        end if
        if spot.surface <> invalid then
            c.surface = spot.surface
            if RngNext(rng) < 0.5 then
                c.crawlDir = 1
            else
                c.crawlDir = -1
            end if
            c.groundY = c.y - c.radius * 0.8 - 0.04
        end if
        if spot.station <> invalid then c.station = spot.station
        if sp.mv = 3 then
            c.hx = 1.0
            c.hy = 0.0
            c.face = 1.0
            c.faceTo = 1.0
            SpawnFindGround(rr, c)
        end if
        slot.members.Push(c)
    end for
    slot.respawnAt = -1.0
    return true
end function

' Where a rooted organism touches the ground (march down the distance field).
sub SpawnFindGround(rr as object, c as object)
    gy = c.y
    for i = 1 to 8
        d = TerrSdf(rr, c.x, gy)
        if d <= 0.03 then exit for
        gy = gy - d
        if c.y - gy > 2.2 then exit for
    end for
    if c.y - gy > 2.2 or gy < 0 then gy = c.y - c.length * 0.3
    c.groundY = gy
end sub

function SpawnFar(w as object, x as float, y as float, minDist as float) as boolean
    if minDist <= 0 then return true
    p = w.player
    if p = invalid then return true
    if not p.alive then return true
    return Dist(p.x, p.y, x, y) >= minDist
end function

' Finds a position for a species in a sector. On success fills m.spawnPos { x, y, surface, station }.
function SpawnPlace(w as object, rr as object, sp as object, sector as integer, bandLo as float, bandHi as float, floorBand as boolean, fixed as boolean, fx as float, fy as float, avoidPlayer as boolean, rng as object) as boolean
    spot = { x: 0.0, y: 0.0, surface: invalid, station: invalid }
    m.spawnPos = spot
    need = 0.0
    if avoidPlayer then
        need = 12.0
        if sp.role = "food" or sp.group = "plant" then need = 9.0
    end if
    if w.player <> invalid and sp.mv = 0 and sp.predatorish then
        if need < 14 then need = 14.0
    end if
    radius = sp.len * sp.rf

    if fixed then
        far = 0.0
        if avoidPlayer then far = 6.0
        if not SpawnFar(w, fx, fy, far) then return false
        spot.x = fx
        spot.y = fy
        return true
    end if

    if sp.cleaner <> "" then
        cands = []
        anyKind = invalid
        for each s in rr.stations
            if s.kind = "both" or s.kind = sp.cleaner then
                if anyKind = invalid then anyKind = s
                if s.sector = sector then cands.Push(s)
            end if
        end for
        st = invalid
        if cands.Count() > 0 then
            st = RngPick(rng, cands)
        else
            st = anyKind
        end if
        if st <> invalid then
            spot.x = WrapX(st.x + RngRange(rng, -0.6, 0.6))
            if sp.mv = 1 then
                spot.y = st.y - 0.35
            else
                spot.y = st.y + RngRange(rng, 0, 0.6)
            end if
            spot.station = st
            return true
        end if
    end if

    by = rr.anchorsBy[sector]

    if sp.anemonesymbiont then
        a = by["anemone"]
        if a <> invalid then
            an = RngPick(rng, a)
            spot.x = WrapX(an.x + RngRange(rng, -0.3, 0.3))
            spot.y = an.y + RngRange(rng, 0, 0.4)
            return true
        end if
    end if

    mv = sp.mv
    if mv = 2 or mv = 5 or (mv = 1 and floorBand) then
        surfs = rr.surfBy[sector]
        if surfs.Count() = 0 then return false
        for t = 0 to 15
            s = RngPick(rng, surfs)
            x = RngRange(rng, s.x0, s.x1)
            y = SurfaceY(s, x) + radius * 0.8 + 0.05
            wx = WrapX(x)
            if TerrSdf(rr, wx, y) > radius * 0.4 then
                if SpawnFar(w, wx, y, need) then
                    spot.x = wx
                    spot.y = y
                    spot.surface = s
                    return true
                end if
            end if
        end for
        return false
    end if

    if mv = 3 then
        kind = "surface"
        if sp.foodset.DoesExist("plankton") then
            kind = "open"
        else if sp.foodset.DoesExist("algae") then
            kind = "algae"
        else if sp.foodset.DoesExist("coral") then
            kind = "coral"
        else if sp.foodset.DoesExist("seagrass") then
            kind = "grass"
        end if
        anchors = []
        a = by[kind]
        if a <> invalid then anchors.Append(a)
        if kind = "surface" then
            a = by["algae"]
            if a <> invalid then anchors.Append(a)
        end if
        if anchors.Count() = 0 then return false
        for t = 0 to 9
            an = RngPick(rng, anchors)
            occupied = false
            for each c in rr.creatures
                if c.sp.mv = 3 and not c.removed then
                    if Dist(c.x, c.y, an.x, an.y) < 0.6 then occupied = true
                end if
            end for
            if not occupied then
                if SpawnFar(w, an.x, an.y, need) then
                    spot.x = an.x
                    spot.y = an.y
                    return true
                end if
            end if
        end for
        return false
    end if

    ' cave dwellers start in dens that fit them
    if sp.cavedweller then
        if RngNext(rng) < 0.6 then
            a = by["cave"]
            if a <> invalid then
                caves = []
                for each an in a
                    if an.sh <> invalid then
                        if rr.shelters[an.sh].clearance >= sp.len * 1.05 then caves.Push(an)
                    end if
                end for
                if caves.Count() > 0 then
                    an = RngPick(rng, caves)
                    if SpawnFar(w, an.x, an.y, need) then
                        spot.x = an.x
                        spot.y = an.y + 0.1
                        return true
                    end if
                end if
            end if
        end if
    end if

    if mv = 4 and sp.foodset.DoesExist("plankton") then
        a = by["open"]
        if a <> invalid then
            opts = []
            for each an in a
                if SpawnFar(w, an.x, an.y, need) then opts.Push(an)
            end for
            if opts.Count() > 0 then
                an = RngPick(rng, opts)
                spot.x = WrapX(an.x + RngRange(rng, -1, 1))
                spot.y = an.y + RngRange(rng, -0.5, 0.5)
                return true
            end if
        end if
    end if

    for t = 0 to 29
        pt = SampleOpenPoint(rr, sector, rng, radius + 0.2, bandLo, bandHi)
        if pt <> invalid then
            if SpawnFar(w, pt.x, pt.y, need) then
                spot.x = pt.x
                spot.y = pt.y
                return true
            end if
        end if
    end for
    for t = 0 to 19
        pt = SampleOpenPoint(rr, sector, rng, radius + 0.2, 0.05, 0.95)
        if pt <> invalid then
            if SpawnFar(w, pt.x, pt.y, need) then
                spot.x = pt.x
                spot.y = pt.y
                return true
            end if
        end if
    end for
    return false
end function

' Respawn, bloom and viable-food bookkeeping. Called every tick; it looks at ten slots per call
' (each slot comes round a couple of times a second), or at all of them when catching up after
' returning to a region.
sub SpawnerUpdate(w as object, rr as object, dt as float, catchUp as boolean)
    rng = w.rng
    now = w.time
    slots = rr.slots
    n = slots.Count()
    if n = 0 then return
    count = 10
    if catchUp or count > n then count = n
    i = rr.slotAt
    if i >= n then i = 0
    for k = 1 to count
        slot = slots[i]
        i = i + 1
        if i >= n then i = 0
        mem = slot.members
        if mem.Count() > 0 then
            keep = []
            for each c in mem
                if c.alive and not c.removed then keep.Push(c)
            end for
            if keep.Count() <> mem.Count() then
                slot.members = keep
                if slot.school <> invalid then slot.school.members = keep
            end if
        end if
        if slot.members.Count() = 0 then
            if slot.respawnAt < 0 then
                delay = RngRange(rng, 25, 55)
                if slot.kind = 1 then delay = delay * 0.6
                slot.respawnAt = now + delay
            end if
            if catchUp and slot.respawnAt - now < dt then slot.respawnAt = now
            if now >= slot.respawnAt then
                if not SpawnSlot(w, rr, slot, rng, true) then slot.respawnAt = now + 3
                w.actDirty = true
            end if
        else if slot.kind = 0 and slot.school <> invalid then
            if rr.bloomUntil[slot.sector] > now then
                ' a predator died here recently: small schooling fish flourish for a while
                cap = Int(slot.group * 1.3 + 0.999)
                if slot.sp.tier <= 2 and slot.members.Count() < cap then
                    if RngNext(rng) < 0.08 then
                        lead = slot.members[0]
                        if SpawnFar(w, lead.x, lead.y, 8.0) then
                            c = WorldAdd(w, slot.sp, lead.x, lead.y, RngRange(rng, 0.85, 1.05), rr)
                            c.school = slot.school
                            c.slot = slot
                            c.behavior = 1
                            slot.members.Push(c)
                        end if
                    end if
                end if
            end if
        end if
    end for
    rr.slotAt = i
    p = w.player
    if p <> invalid and not catchUp then
        if p.alive and w.tick MOD 150 = 0 then SpawnerEnsureFood(w, rr)
    end if
end sub

' If almost nothing nearby is edible for the player, bring in something that is (out of view).
sub SpawnerEnsureFood(w as object, rr as object)
    p = w.player
    count = 0
    for each c in w.act
        if c.alive and not c.isPlayer then
            if c.pvStamp <> w.playerVersion then BrainRefreshPv(w, c, p)
            if c.pvEdible and c.pvFSpine < 8 then count = count + 1
        end if
    end for
    if count >= 5 then return
    opts = SpawnerViableSpecies(w)
    maxTier = p.sp.tier
    if maxTier < 3 then maxTier = 3
    total = 0.0
    pool = []
    weights = []
    for each s in opts
        if s.tier <= maxTier then
            wt = 1.0
            if s.role = "food" then wt = 2.0
            if s.schooling then wt = wt * 1.5
            pool.Push(s)
            weights.Push(wt)
            total = total + wt
        end if
    end for
    if pool.Count() = 0 then return
    rng = w.rng
    r = RngNext(rng) * total
    sp = pool[pool.Count() - 1]
    for i = 0 to pool.Count() - 1
        r = r - weights[i]
        if r <= 0 then
            sp = pool[i]
            exit for
        end if
    end for
    ' prefer the player's sector or a neighbour, out of view
    ps = p.sector
    sectors = [ps, (ps + 1) MOD 9, (ps + 8) MOD 9, (ps + 3) MOD 9, (ps + 6) MOD 9]
    for each sector in sectors
        if SpawnPlace(w, rr, sp, sector, sp.slo, sp.shi, sp.band = "floor", false, 0.0, 0.0, true, rng) then
            spot = m.spawnPos
            n = 1
            school = invalid
            if sp.schooling then
                n = sp.school.count
                if n > 5 then n = 5
                school = { x: spot.x, y: spot.y, until: -1.0, members: [], id: w.schoolCounter }
                w.schoolCounter = w.schoolCounter + 1
            end if
            for i = 1 to n
                c = WorldAdd(w, sp, spot.x + RngRange(rng, -0.8, 0.8), spot.y + RngRange(rng, -0.4, 0.4), RngRange(rng, 0.85, 1.0), rr)
                if TerrSdf(rr, c.x, c.y) < c.radius then
                    c.x = spot.x
                    c.y = spot.y
                end if
                c.homeX = c.x
                c.homeY = c.y
                if school <> invalid then
                    c.school = school
                    school.members.Push(c)
                    c.behavior = 1
                end if
                if spot.surface <> invalid then
                    c.surface = spot.surface
                    c.groundY = c.y - c.radius * 0.8 - 0.04
                end if
                if sp.mv = 3 then SpawnFindGround(rr, c)
            end for
            return
        end if
    end for
end sub

' Species the player could eat with the current body and diet (cached per size bucket).
function SpawnerViableSpecies(w as object) as object
    p = w.player
    key = p.sp.id + ":" + Int(p.length * 10 + 0.5).ToStr() + ":" + w.ps.milestone.ToStr()
    if m.viableKey = key then return m.viableList
    out = []
    ms = WorldMilestone(w, p)
    if m.probes = invalid then m.probes = {}
    for each s in m.species
        ok = true
        if s.role = "fixture" or s.role = "hazard" or s.role = "cleaner" or s.id = p.sp.id then ok = false
        if ok and s.mv = 3 and s.charges <= 0 then ok = false
        if ok then
            probe = m.probes[s.id]
            if probe = invalid then
                probe = CreatureNew(-1, s, 0.0, 0.0, 1.0)
                m.probes[s.id] = probe
            end if
            CheckFeed(w, p, probe, ms, true, false, false)
            f = m.fc
            if (f.result = "SWALLOW" or f.result = "BITE") and f.spine < 8 then out.Push(s)
        end if
    end for
    m.viableKey = key
    m.viableList = out
    return out
end function
