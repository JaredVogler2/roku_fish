' ============================================================================
' data.brs - game content: species, abilities, balance numbers, the food-web matrix.
'
' The JSON is exported from the REEFBOUND web game's own data modules (tools/export-data), so the
' numbers and rules match the original. Fields that the simulation tests every tick are
' pre-digested here into integers and lookup tables.
' ============================================================================

' movement codes
function MvSwim() as integer
    return 0
end function
function MvHover() as integer
    return 1
end function
function MvCrawl() as integer
    return 2
end function
function MvSessile() as integer
    return 3
end function
function MvDrift() as integer
    return 4
end function
function MvBurrow() as integer
    return 5
end function

function DataLoad() as boolean
    j = ReadJson("pkg:/data/species.json")
    b = ReadJson("pkg:/data/balance.json")
    fw = ReadJson("pkg:/data/foodweb.json")
    if j = invalid or b = invalid or fw = invalid then return false
    m.bal = b.balance
    m.cfgData = b
    m.species = j.species
    m.abilities = {}
    for each a in j.abilities
        m.abilities[a.id] = a
    end for
    m.upgrades = j.upgrades
    m.foodLabels = j.foodlabels
    m.eat = fw.eat
    m.threat = fw.threat
    m.speciesById = {}
    i = 0
    for each sp in m.species
        SpeciesPrepare(sp, i)
        m.speciesById[sp.id] = sp
        i = i + 1
    end for
    m.speciesBase = m.species.Count()
    ' "hunter": a species that some swimmer has reason to fear (it eats mobile animals) or a hazard.
    ' Only hunters are scanned when a fish looks for threats.
    n = m.species.Count()
    for a = 0 to n - 1
        sp = m.species[a]
        h = (sp.role = "hazard")
        row = m.threat[a]
        for t = 0 to n - 1
            if row[t] = 1 then h = true
        end for
        sp.hunter = h
    end for
    ' Flatten the eat matrix into parallel arrays: [attacker * n + target]
    total = n * n
    eatMode = CreateObject("roArray", total, false)
    eatPref = CreateObject("roArray", total, false)
    eatSpine = CreateObject("roArray", total, false)
    eatVal = CreateObject("roArray", total, false)
    for a = 0 to n - 1
        row = m.eat[a]
        for t = 0 to n - 1
            e = row[t]
            if type(e) = "roArray" then
                eatMode.Push(e[0])
                eatPref.Push(e[1] * 0.01)
                eatSpine.Push(e[2] * 0.1)
                eatVal.Push(e[3] * 0.1)
            else
                eatMode.Push(0)
                eatPref.Push(0.0)
                eatSpine.Push(0.0)
                eatVal.Push(0.0)
            end if
        end for
    end for
    m.eatMode = eatMode
    m.eatPref = eatPref
    m.eatSpine = eatSpine
    m.eatVal = eatVal
    m.eat = invalid
    return true
end function

function GetSpecies(id as string) as dynamic
    return m.speciesById[id]
end function

' Adds the derived fields the simulation uses. Also called for Reef Lab designs.
sub SpeciesPrepare(sp as object, idx as integer)
    sp.idx = idx
    mv = 0
    if sp.movement = "hover" then
        mv = 1
    else if sp.movement = "crawl" then
        mv = 2
    else if sp.movement = "sessile" then
        mv = 3
    else if sp.movement = "drift" then
        mv = 4
    else if sp.movement = "burrow" then
        mv = 5
    end if
    sp.mv = mv
    sp.mobile = (mv = 0 or mv = 1)
    sp.fishlike = (sp.group = "fish" or sp.group = "ray" or sp.group = "shark" or sp.group = "cephalopod")
    act = 0
    if sp.activity = "day" then
        act = 1
    else if sp.activity = "night" then
        act = 2
    else if sp.activity = "twilight" then
        act = 3
    end if
    sp.act = act
    if sp.role = invalid then sp.role = ""
    if sp.charges = invalid then sp.charges = 0
    if sp.regen = invalid then sp.regen = 0
    if sp.ambush = invalid then sp.ambush = false
    if sp.protected = invalid then sp.protected = false
    if sp.anemonesymbiont = invalid then sp.anemonesymbiont = false
    if sp.cleaner = invalid then sp.cleaner = ""
    if sp.emissive = invalid then sp.emissive = ""
    if sp.fictional = invalid then sp.fictional = false
    sp.hasnutrition = (sp.nutrition <> invalid)
    if sp.nutrition = invalid then sp.nutrition = 0
    ' diet lookup by food tag
    dm = {}
    fishDiet = false
    biteOnly = false
    for each e in sp.diet
        if e.biteonly = invalid then e.biteonly = false
        if e.tol = invalid then e.tol = 0
        if e.ms = invalid then e.ms = 0
        if e.ability = invalid then e.ability = ""
        if e.minratio = invalid then e.minratio = -1
        if e.maxratio = invalid then e.maxratio = -1
        dm[e.tag] = e
        if e.tag = "smallFish" or e.tag = "mediumFish" or e.tag = "largeFish" then fishDiet = true
        if e.biteonly then biteOnly = true
    end for
    sp.dietmap = dm
    sp.predatorish = (sp.tier >= 4 and fishDiet)
    sp.hasbiteonly = biteOnly
    plant = false
    fset = {}
    for each t in sp.foodtags
        fset[t] = true
        if t = "algae" or t = "seagrass" or t = "plankton" or t = "coral" or t = "sponge" then plant = true
    end for
    sp.plantlike = plant
    sp.foodset = fset
    ab = {}
    for each a in sp.abilities
        ab[a] = true
    end for
    sp.abset = ab
    rmin = 9
    rmax = -1
    for each r in sp.rows
        if r < rmin then rmin = r
        if r > rmax then rmax = r
    end for
    sp.rowmin = rmin
    sp.rowmax = rmax
    ' vertical band inside a sector: AI roaming (lo, hi) and spawn placement (slo, shi)
    bnd = sp.band
    if bnd = "surface" then
        sp.blo = 0.8 : sp.bhi = 0.97 : sp.slo = 0.82 : sp.shi = 0.97
    else if bnd = "high" then
        sp.blo = 0.55 : sp.bhi = 0.95 : sp.slo = 0.55 : sp.shi = 0.95
    else if bnd = "mid" then
        sp.blo = 0.28 : sp.bhi = 0.8 : sp.slo = 0.3 : sp.shi = 0.78
    else if bnd = "low" then
        sp.blo = 0.08 : sp.bhi = 0.5 : sp.slo = 0.1 : sp.shi = 0.48
    else if bnd = "floor" then
        sp.blo = 0.03 : sp.bhi = 0.3 : sp.slo = 0.02 : sp.shi = 0.28
    else
        sp.blo = 0.08 : sp.bhi = 0.92 : sp.slo = 0.06 : sp.shi = 0.94
    end if
    sp.patroller = (sp.group = "shark" or ArrayHas(sp.habitat, "open") or sp.tier >= 7)
    sp.cavedweller = ArrayHas(sp.habitat, "cave")
    ' body radius as a fraction of length (collision and bite reach)
    rf = 0.2
    if sp.group = "ray" then
        rf = 0.36
    else if sp.group = "plant" then
        rf = 0.45
    else if sp.group = "invertebrate" then
        rf = 0.4
        if mv = 3 then rf = 0.45
    else if sp.group = "other" then
        rf = 0.5
    else if sp.model = "puffer" or sp.model = "cowfish" or sp.model = "frogfish" then
        rf = 0.3
    else if sp.model = "moray" or sp.model = "needlefish" then
        rf = 0.1
    end if
    sp.rf = rf
    sp.sprite = LCase(sp.id)
    if sp.swim > 0.05 then
        sp.invswim = 1.0 / sp.swim
    else
        sp.invswim = 0.0
    end if
    ab0 = "none"
    ab1 = ""
    if sp.abilities.Count() > 0 then ab0 = sp.abilities[0]
    if sp.abilities.Count() > 1 then ab1 = sp.abilities[1]
    sp.ab0 = ab0
    sp.ab1 = ab1
    sp.burstsprint = (ab.DoesExist("burstSprint"))
    if sp.school = invalid then
        sp.schooling = false
        sp.cohesion = 0.6
    else
        sp.schooling = true
        sp.cohesion = sp.school.cohesion
    end if
    if sp.custom = invalid then sp.custom = 1.0
    if sp.hunter = invalid then sp.hunter = sp.predatorish
end sub

' ---------------------------------------------------------------- day / night
' dayTime in [0,1): 0 = midnight, 0.25 = 6 am, 0.5 = noon, 0.75 = 6 pm.
' phase: 0 night, 1 dawn, 2 day, 3 dusk.
function PhaseOf(dayTime as float) as integer
    if dayTime >= 0.2 and dayTime < 0.3 then return 1
    if dayTime >= 0.3 and dayTime < 0.7 then return 2
    if dayTime >= 0.7 and dayTime < 0.8 then return 3
    return 0
end function

function Daylight(dayTime as float) as float
    if dayTime < 0.5 then return Smoothstep(0.2, 0.3, dayTime)
    return 1.0 - Smoothstep(0.7, 0.8, dayTime)
end function

' act: 0 any, 1 day, 2 night, 3 twilight
function IsActive(act as integer, phase as integer) as boolean
    if act = 0 then return true
    if act = 1 then return phase <> 0
    if act = 2 then return phase <> 2
    return (phase = 1 or phase = 3)
end function

function ActivityLevel(act as integer, phase as integer) as float
    if IsActive(act, phase) then return 1.0
    if act = 3 then return 0.45
    return 0.2
end function

function PhaseLabel(phase as integer) as string
    if phase = 1 then return "Dawn"
    if phase = 2 then return "Day"
    if phase = 3 then return "Dusk"
    return "Night"
end function

function ClockString(dayTime as float) as string
    mins = Int(dayTime * 1440)
    h = (mins \ 60) MOD 24
    mm = mins MOD 60
    return Pad2(h) + ":" + Pad2(mm)
end function

function MilestoneForMass(mass as float) as integer
    ms = m.bal.growth.milestones
    idx = 0
    n = ms.Count()
    for i = 0 to n - 1
        if mass >= ms[i] then idx = i
    end for
    return idx
end function

function TournamentTarget(stage as integer) as integer
    return m.bal.score.tournamentbase + m.bal.score.tournamentperstage * stage
end function

function RegionName(id as string) as string
    if id = "outer" then return "Outer Wall & Bluewater"
    if id = "wreck" then return "Twilight Wreck & Caverns"
    return "Lagoon Reef"
end function

function ShelterPhrase(kind as string) as string
    if kind = "cave" then return "a cave"
    if kind = "coral" then return "a coral thicket"
    if kind = "seagrass" then return "a seagrass bed"
    if kind = "anemone" then return "an anemone"
    if kind = "crevice" then return "a crevice"
    return "a gap in the wreck"
end function
