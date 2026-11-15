' ============================================================================
' terrain.brs - collision and shelter queries on a region.
'
' The web game evaluates signed-distance primitives (circles, capsules, boxes, seabed) for every
' query. That is far too slow in BrightScript, so the build bakes each region into a grid
' (region_<id>.bin, 0.25 units per sample, 289 x 163 samples, x wraps):
'   layer 0      signed distance to rock / seabed, one byte: (d / 0.04) + 128
'   layers 1..3  ids (+1) of up to three shelters within 1.6 units of the sample
' A query is then a bilinear lookup that yields both distance and surface normal, plus at most
' three shelter boxes. Shelters are hiding places with a "clearance": a body longer than the
' clearance cannot enter, so for that body the shelter is solid.
' ============================================================================

function RegionLoad(id as string) as dynamic
    j = ReadJson("pkg:/data/region_" + id + ".json")
    if j = invalid then return invalid
    grid = CreateObject("roByteArray")
    if not grid.ReadFile("pkg:/data/region_" + id + ".bin") then
        print "RegionLoad: grid missing for "; id
        return invalid
    end if
    rr = {
        id: id
        name: j.name
        grid: grid
        gw: j.grid.w
        gh: j.grid.h
        gn: j.grid.w * j.grid.h
        sectors: j.sectors
        shelters: j.shelters
        stations: j.stations
        surfaces: j.surfaces
        anchors: j.anchors
        fixed: j.fixed
        passes: j.passes
        creatures: []
        slots: []
        populated: false
        slotAt: 0
        lastActive: 0.0
        bloomUntil: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        schoolTargets: {}
    }
    if grid.Count() < rr.gn * 4 then
        print "RegionLoad: grid too small for "; id
        return invalid
    end if
    ' anchors by sector and kind for the spawner
    bySector = []
    for i = 0 to 8
        bySector.Push({})
    end for
    for each a in rr.anchors
        lst = bySector[a.s][a.k]
        if lst = invalid then
            lst = []
            bySector[a.s][a.k] = lst
        end if
        lst.Push(a)
    end for
    rr.anchorsBy = bySector
    surfBy = []
    for i = 0 to 8
        surfBy.Push([])
    end for
    for each s in rr.surfaces
        surfBy[s.sector].Push(s)
    end for
    rr.surfBy = surfBy
    return rr
end function

' Signed distance to rock / seabed (negative inside). Bilinear.
function TerrSdf(rr as object, x as float, y as float) as float
    fx = x * 4.0
    ix = Int(fx)
    tx = fx - ix
    ix = ix MOD 288
    if ix < 0 then ix = ix + 288
    fy = y * 4.0
    if fy < 0 then fy = 0.0
    if fy > 161.99 then fy = 161.99
    iy = Int(fy)
    ty = fy - iy
    g = rr.grid
    i = iy * 289 + ix
    d00 = g[i]
    d10 = g[i + 1]
    a = d00 + (d10 - d00) * tx
    d01 = g[i + 289]
    d11 = g[i + 290]
    b = d01 + (d11 - d01) * tx
    return (a + (b - a) * ty - 128) * 0.04
end function

' Nearest-sample distance (cheap; for line-of-sight marching and coarse checks).
function TerrSdfFast(rr as object, x as float, y as float) as float
    ix = Int(x * 4.0 + 0.5) MOD 288
    if ix < 0 then ix = ix + 288
    iy = Int(y * 4.0 + 0.5)
    if iy < 0 then iy = 0
    if iy > 162 then iy = 162
    return (rr.grid[iy * 289 + ix] - 128) * 0.04
end function

' Distance for a body of the given length: shelters too small for it count as solid.
' Writes the distance to m.td and the outward unit normal to m.tnx / m.tny.
sub TerrSample(rr as object, x as float, y as float, bodyLength as float)
    fx = x * 4.0
    ix = Int(fx)
    tx = fx - ix
    ix = ix MOD 288
    if ix < 0 then ix = ix + 288
    fy = y * 4.0
    if fy < 0 then fy = 0.0
    if fy > 161.99 then fy = 161.99
    iy = Int(fy)
    ty = fy - iy
    g = rr.grid
    i = iy * 289 + ix
    d00 = g[i]
    d10 = g[i + 1]
    d01 = g[i + 289]
    d11 = g[i + 290]
    a = d00 + (d10 - d00) * tx
    b = d01 + (d11 - d01) * tx
    d = (a + (b - a) * ty - 128) * 0.04
    gx = (d10 - d00) * (1 - ty) + (d11 - d01) * ty
    gy = (d01 - d00) * (1 - tx) + (d11 - d10) * tx
    ' shelters near this point
    j = rr.gn + (iy + Int(ty + 0.5)) * 289 + ix + Int(tx + 0.5)
    id1 = g[j]
    if id1 > 0 then
        shs = rr.shelters
        n = rr.gn
        k = 0
        while id1 > 0
            s = shs[id1 - 1]
            if bodyLength > s.clearance then
                dx = x - s.x
                if dx > 36 then
                    dx = dx - 72
                else if dx < -36 then
                    dx = dx + 72
                end if
                dy = y - s.y
                adx = dx
                if adx < 0 then adx = -adx
                ady = dy
                if ady < 0 then ady = -ady
                qx = adx - (s.hw - 0.2)
                qy = ady - (s.hh - 0.2)
                if qx > 0 or qy > 0 then
                    ox = qx
                    if ox < 0 then ox = 0
                    oy = qy
                    if oy < 0 then oy = 0
                    l = Sqr(ox * ox + oy * oy)
                    sd = l - 0.2
                    if sd < d then
                        d = sd
                        if l > 0.0001 then
                            gx = ox / l
                            gy = oy / l
                        else
                            gx = 1.0
                            gy = 0.0
                        end if
                        if dx < 0 then gx = -gx
                        if dy < 0 then gy = -gy
                    end if
                else
                    ' inside the box: push out through the nearest face
                    if qx > qy then
                        sd = qx - 0.2
                        if sd < d then
                            d = sd
                            gx = 1.0
                            if dx < 0 then gx = -1.0
                            gy = 0.0
                        end if
                    else
                        sd = qy - 0.2
                        if sd < d then
                            d = sd
                            gx = 0.0
                            gy = 1.0
                            if dy < 0 then gy = -1.0
                        end if
                    end if
                end if
            end if
            k = k + 1
            if k >= 3 then
                id1 = 0
            else
                id1 = g[j + n * k]
            end if
        end while
    end if
    l = Sqr(gx * gx + gy * gy)
    if l < 0.0001 then
        m.tnx = 0.0
        m.tny = 1.0
    else
        m.tnx = gx / l
        m.tny = gy / l
    end if
    m.td = d
end sub

function TerrSdfFor(rr as object, x as float, y as float, bodyLength as float) as float
    TerrSample(rr, x, y, bodyLength)
    return m.td
end function

' Push a creature out of terrain; also keeps it below the surface and above the region bottom.
' Leaves m.thit (did it touch something) and m.td (distance at its final position).
sub TerrResolve(rr as object, c as object, radius as float, bodyLength as float)
    hit = false
    for iter = 0 to 2
        TerrSample(rr, c.x, c.y, bodyLength)
        d = m.td
        if d >= radius then exit for
        push = radius - d + 0.001
        nx = m.tnx
        ny = m.tny
        x = c.x + nx * push
        if x >= 72 then
            x = x - 72
        else if x < 0 then
            x = x + 72
        end if
        c.x = x
        c.y = c.y + ny * push
        vn = c.vx * nx + c.vy * ny
        if vn < 0 then
            c.vx = c.vx - vn * nx * 1.05
            c.vy = c.vy - vn * ny * 1.05
        end if
        hit = true
    end for
    top = 40.35 - radius * 0.5
    if c.y > top then
        c.y = top
        if c.vy > 0 then c.vy = c.vy * -0.2
    end if
    if c.y < radius then c.y = radius
    m.thit = hit
end sub

' Sampled line of sight against rock (caves are handled through shelters).
function TerrLineOfSight(rr as object, ax as float, ay as float, bx as float, by as float) as boolean
    dx = bx - ax
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    dy = by - ay
    l = Sqr(dx * dx + dy * dy)
    steps = Int(l / 0.6) + 1
    if steps < 2 then steps = 2
    g = rr.grid
    for i = 1 to steps - 1
        t = i / steps
        ix = Int((ax + dx * t) * 4.0 + 0.5) MOD 288
        if ix < 0 then ix = ix + 288
        iy = Int((ay + dy * t) * 4.0 + 0.5)
        if iy < 0 then iy = 0
        if iy > 162 then iy = 162
        ' -0.05 units = 1.25 steps below the surface value
        if g[iy * 289 + ix] < 127 then return false
    end for
    return true
end function

' Index of the best shelter containing the point that the body fits in, or -1. Result in m.tsh.
sub TerrShelterAt(rr as object, x as float, y as float, bodyLength as float)
    ix = Int(x * 4.0 + 0.5) MOD 288
    if ix < 0 then ix = ix + 288
    iy = Int(y * 4.0 + 0.5)
    if iy < 0 then iy = 0
    if iy > 162 then iy = 162
    g = rr.grid
    n = rr.gn
    j = n + iy * 289 + ix
    id1 = g[j]
    if id1 = 0 then
        m.tsh = -1
        return
    end if
    best = -1
    bestC = -1.0
    shs = rr.shelters
    for k = 0 to 2
        id1 = g[j + n * k]
        if id1 = 0 then exit for
        s = shs[id1 - 1]
        if bodyLength <= s.clearance then
            dx = x - s.x
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            if dx < 0 then dx = -dx
            dy = y - s.y
            if dy < 0 then dy = -dy
            if dx <= s.hw and dy <= s.hh then
                if s.concealment > bestC then
                    bestC = s.concealment
                    best = id1 - 1
                end if
            end if
        end if
    end for
    m.tsh = best
end sub

' A body that grew while inside a shelter must still be able to swim out: shelters that contain
' the point stop counting as solid by shrinking the length used for collision. Result in m.tcl.
sub TerrCollisionLength(rr as object, x as float, y as float, bodyLength as float)
    ix = Int(x * 4.0 + 0.5) MOD 288
    if ix < 0 then ix = ix + 288
    iy = Int(y * 4.0 + 0.5)
    if iy < 0 then iy = 0
    if iy > 162 then iy = 162
    g = rr.grid
    n = rr.gn
    j = n + iy * 289 + ix
    if g[j] = 0 then
        m.tcl = bodyLength
        return
    end if
    L = bodyLength
    shs = rr.shelters
    for k = 0 to 2
        id1 = g[j + n * k]
        if id1 = 0 then exit for
        s = shs[id1 - 1]
        if L > s.clearance then
            dx = x - s.x
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            if dx < 0 then dx = -dx
            dy = y - s.y
            if dy < 0 then dy = -dy
            if dx <= s.hw and dy <= s.hh then L = s.clearance
        end if
    end for
    m.tcl = L
end sub

' Nearest shelter the body fits in, within maxDist; returns the shelter or invalid.
function TerrNearestShelter(rr as object, x as float, y as float, bodyLength as float, maxDist as float) as dynamic
    best = invalid
    bd = maxDist
    for each s in rr.shelters
        if bodyLength <= s.clearance then
            dx = s.x - x
            if dx > 36 then
                dx = dx - 72
            else if dx < -36 then
                dx = dx + 72
            end if
            if dx < bd and dx > -bd then
                dy = s.y - y
                d = Sqr(dx * dx + dy * dy)
                if d < bd then
                    bd = d
                    best = s
                end if
            end if
        end if
    end for
    return best
end function

' Is a straight swim from the creature to (x, y) free of rock for a body of this size?
function TerrClearPath(rr as object, cx as float, cy as float, x as float, y as float, radius as float, bodyLength as float) as boolean
    dx = x - cx
    if dx > 36 then
        dx = dx - 72
    else if dx < -36 then
        dx = dx + 72
    end if
    dy = y - cy
    l = Sqr(dx * dx + dy * dy)
    steps = Int(l / 0.6) + 1
    need = radius + 0.05
    for i = 1 to steps
        t = i / steps
        px = cx + dx * t
        if px >= 72 then
            px = px - 72
        else if px < 0 then
            px = px + 72
        end if
        if TerrSdfFor(rr, px, cy + dy * t, bodyLength) < need then return false
    end for
    return true
end function

' Height of a crawl surface at x (surfaces store sampled heights).
function SurfaceY(s as object, x as float) as float
    span = s.x1 - s.x0
    if span < 0.001 then span = 0.001
    t = (x - s.x0) / span
    if t < 0 then t = 0.0
    if t > 1 then t = 1.0
    ys = s.ys
    n = ys.Count() - 1
    f = t * n
    i = Int(f)
    if i >= n then return ys[n]
    return ys[i] + (ys[i + 1] - ys[i]) * (f - i)
end function

' Free-water point in a sector within a vertical band (0 bottom .. 1 top of the sector), or invalid.
function SampleOpenPoint(rr as object, sector as integer, rng as object, radius as float, bandLo as float, bandHi as float) as dynamic
    col = sector MOD 3
    row = sector \ 3
    lx = RngRange(rng, 0.8, 23.2)
    ly = RngRange(rng, 0.4 + bandLo * 12.7, 0.4 + bandHi * 12.7)
    x = col * 24.0 + lx
    y = (2 - row) * 13.5 + ly
    if y >= 39.9 then return invalid
    if TerrSdf(rr, x, y) > radius + 0.25 then return { x: x, y: y }
    return invalid
end function
