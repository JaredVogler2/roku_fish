' ============================================================================
' creator.brs - Reef Lab (Create-a-Fish): a 1,000-point design budget turned into a species
' that plugs into the same food web, AI and abilities as every other fish.
' Ported from the web game's data/customFish.ts.
' ============================================================================

function CreatorDefault() as object
    dt = CreateObject("roDateTime")
    return {
        id: "custom-" + dt.AsSeconds().ToStr()
        name: "Reef Prototype"
        archetype: "fusiform"
        sizeclass: "small"
        speed: 2
        endurance: 2
        agility: 2
        mouth: 1
        armor: 0
        look: 0
        activity: "any"
        ability: "burstSprint"
        diet: "omnivore"
    }
end function

function CreatorCost(d as object) as integer
    c = m.cfgData.creator
    cost = c.sizecost[d.sizeclass]
    cost = cost + c.statcost.speed * d.speed + c.statcost.endurance * d.endurance + c.statcost.agility * d.agility
    cost = cost + c.statcost.mouth * d.mouth + c.statcost.armor * d.armor
    cost = cost + c.abilitycost[LCase(d.ability)] + c.dietcost[d.diet] + c.archetypecost[LCase(d.archetype)]
    return cost
end function

' Human-readable problems; an empty list means the design is valid.
function CreatorValidate(d as object) as object
    issues = []
    cost = CreatorCost(d)
    budget = m.cfgData.creator.budget
    if cost > budget then issues.Push("Over budget by " + (cost - budget).ToStr() + " points.")
    if d.ability = "inflate" and d.archetype <> "puffer" then issues.Push("Only a puffer body can inflate.")
    if d.ability = "sting" and d.archetype <> "ray" then issues.Push("A venomous tail sting needs a ray body.")
    if d.ability = "inkCloud" and d.archetype = "puffer" then issues.Push("Ink needs an ink sac - not available for puffers.")
    if d.archetype = "puffer" and d.speed > 2 then issues.Push("Puffer bodies are slow: speed level 2 maximum.")
    if d.archetype = "eel" and d.armor > 2 then issues.Push("Eel bodies are flexible: armor level 2 maximum.")
    if d.diet = "piscivore" and d.mouth < 1 then issues.Push("A fish-eater needs at least mouth level 1.")
    if d.diet = "herbivore" and d.ability = "lure" then issues.Push("A lure is pointless for a grazer.")
    if d.sizeclass = "large" and d.agility > 3 then issues.Push("Large bodies cannot reach agility 4.")
    return issues
end function

' Each Reef Lab body borrows the look of an existing reef fish (drawn from the same sprites).
function CreatorLooks(archetype as string) as object
    if archetype = "deepBody" then return ["threadfinButterfly", "semicircleAngel", "moorishIdol", "longfinSpadefish", "paletteSurgeon", "achillesTang"]
    if archetype = "ray" then return ["bluespottedRay", "electricRay", "guitarfish"]
    if archetype = "eel" then return ["whitemouthMoray"]
    if archetype = "puffer" then return ["bsPuffer", "cowfish", "paintedFrogfish"]
    return ["lumenWrasse", "neonDamsel", "rainbowRunner", "clownCoris", "coralGrouper", "pygmyParrot", "silverSprat", "doublelinedMackerel"]
end function

function CreatorDiet(d as object) as object
    big = (d.sizeclass <> "small")
    diet = d.diet
    out = []
    if diet = "herbivore" then
        out = [{ tag: "algae", pref: 1.0, biteonly: true }, { tag: "seagrass", pref: 0.8, biteonly: true }, { tag: "coral", pref: 0.5, biteonly: true }]
    else if diet = "planktivore" then
        out = [{ tag: "plankton", pref: 1.0 }, { tag: "smallCrustacean", pref: 0.6 }]
    else if diet = "invertivore" then
        out = [{ tag: "worm", pref: 0.9 }, { tag: "smallCrustacean", pref: 0.9 }, { tag: "crab", pref: 0.8 }, { tag: "mollusk", pref: 0.6 }, { tag: "snail", pref: 0.6 }, { tag: "brittleStar", pref: 0.6 }, { tag: "urchin", pref: 0.4, tol: 0.8 }]
    else if diet = "piscivore" then
        out = [{ tag: "smallFish", pref: 1.0 }]
        if big then out.Push({ tag: "mediumFish", pref: 0.8 })
        if d.sizeclass = "large" then
            out.Push({ tag: "largeFish", pref: 0.6 })
            out.Push({ tag: "cephalopod", pref: 0.7 })
        end if
        out.Push({ tag: "smallCrustacean", pref: 0.4 })
    else
        out = [{ tag: "plankton", pref: 0.6 }, { tag: "algae", pref: 0.4, biteonly: true }, { tag: "worm", pref: 0.7 }, { tag: "smallCrustacean", pref: 0.8 }, { tag: "smallFish", pref: 0.7 }]
        if big then out.Push({ tag: "crab", pref: 0.5 })
    end if
    return out
end function

' Build the species record for a design (same derived values as the web game's species builder).
function CustomFishSpecies(d as object) as object
    length = 0.55
    tier = 2
    if d.sizeclass = "medium" then
        length = 1.15
        tier = 4
    else if d.sizeclass = "large" then
        length = 2.2
        tier = 6
    end if
    looks = CreatorLooks(d.archetype)
    li = d.look
    if li < 0 or li >= looks.Count() then li = 0
    lookSp = GetSpecies(looks[li])
    speedMul = 0.8 + 0.12 * d.speed
    capLen = length
    if capLen > 4 then capLen = 4.0
    swim = (2.3 + 0.42 * capLen) * speedMul
    burst = swim * 1.9
    agility = 0.4 + 0.12 * d.agility
    if agility > 0.95 then agility = 0.95
    group = "fish"
    if d.archetype = "ray" then group = "ray"
    spines = 0.0
    tox = 0.0
    if d.archetype = "puffer" then
        spines = 0.15
        tox = 0.5
    end if
    perception = 4.5 + 2.2 * length
    if perception > 13 then perception = 13.0
    nm = d.name
    if nm = "" then nm = "Custom Fish"
    sp = {
        id: "custom:" + d.id
        name: nm
        group: group
        archetype: "custom-" + d.archetype
        activity: d.activity
        habitat: ["reef", "open", "sand"]
        rows: [0, 1, 2]
        band: "any"
        movement: "swim"
        tier: tier
        len: length
        mass: Int(11 * length * length * length * 1000 + 0.5) / 1000.0
        health: Int(40 + 25 * length + 0.5)
        swim: Int(swim * 100 + 0.5) / 100.0
        burst: Int(burst * 100 + 0.5) / 100.0
        accel: 7.5 / (1 + 0.25 * length)
        agility: agility
        perception: perception
        gape: 0.35 + 0.12 * d.mouth
        bite: 0.2 + 0.17 * d.mouth
        armor: 0.14 * d.armor
        venomres: 0.0
        tox: tox
        spines: spines
        foodtags: []
        sizetag: true
        diet: CreatorDiet(d)
        abilities: [d.ability]
        model: lookSp.model
        pattern: lookSp.pattern
        palette: lookSp.palette
        playable: true
        fictional: true
        summary: "A custom fish designed in the Reef Lab (" + d.archetype + ", " + d.sizeclass + ", " + d.diet + ")."
        fact: "Game-character design, not genetic engineering: real fish traits evolve over many generations."
        stylization: "Created with the Reef Lab budget system. Its body plan follows simplified game rules."
        prey: []
        predators: []
        custom: 1.25 - 0.12 * d.endurance
    }
    SpeciesPrepare(sp, 9999)
    sp.sprite = lookSp.sprite
    return sp
end function
