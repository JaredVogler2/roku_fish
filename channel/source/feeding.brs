' ============================================================================
' feeding.brs - the food-web rules: who can eat what, and why not.
'
' CheckFeed is a faithful port of the web game's checkFeed: the same ordered checks (etiquette,
' diet edge, range and obstruction, inflation, armour, size / gape, spines, toxicity) and the
' same result codes and reasons. It is used for the player, for contact resolution and for the
' target halos. NPC perception sweeps use the precomputed species matrix instead (data.brs).
'
' Results: "SWALLOW" "BITE" "HARMFUL_BITE" "REPELLED" "MISSED" "FORBIDDEN_DIET" "TOO_LARGE"
'          "ARMORED" "OBSTRUCTED" "COOLDOWN"
' The verdict is written to m.fc (one shared record, no allocation per call):
'   result, reason, pref, spine, toxin, risk (0 neutral, 1 edible, 2 risky, 3 dangerous), locked
' ============================================================================

sub FeedInit()
    m.fc = { result: "MISSED", reason: "", pref: 0.0, spine: 0.0, toxin: 0.0, risk: 0, locked: -1, edge: invalid }
end sub

' Size food tag of a fish-like animal: small / medium / large by current length.
function SizeTag(length as float) as string
    if length <= 0.85 then return "smallFish"
    if length <= 2.1 then return "mediumFish"
    return "largeFish"
end function

function SpineLevel(t as object) as float
    s = t.sp.spines + t.mSpines
    if t.abCount > 0 then
        if t.ab.DoesExist("defensiveSpines") then s = s + 0.5
        if t.ab.DoesExist("inflate") then s = s + 0.55
    end if
    if s < 0 then s = 0.0
    if s > 1.2 then s = 1.2
    return s
end function

function CanTearChunks(a as object) as boolean
    return (a.sp.group = "shark" or a.sp.bite >= 0.6)
end function

sub FeedSet(result as string, reason as string, edge as dynamic, spine as float, toxin as float)
    f = m.fc
    f.result = result
    f.reason = reason
    f.edge = edge
    f.spine = spine
    f.toxin = toxin
    f.locked = -1
    risk = 0
    if result = "SWALLOW" or result = "BITE" then
        risk = 1
        if spine > 0 then risk = 2
    else if result = "HARMFUL_BITE" or result = "REPELLED" then
        risk = 3
    end if
    f.risk = risk
    if edge <> invalid then
        f.pref = edge.pref
    else
        f.pref = 0.0
    end if
end sub

' milestone: the attacker's Ascension milestone, or -1 for no milestone gating.
' ignoreRange: skip reach / obstruction (hints, AI planning). contact: the lunge already touched.
' mimicNibble: the cleaner-mimic trick guarantees a nibble on larger fish.
sub CheckFeed(w as object, a as object, t as object, milestone as integer, ignoreRange as boolean, contact as boolean, mimicNibble as boolean)
    asp = a.sp
    tsp = t.sp
    if a.id = t.id or (not t.alive) or t.removed then
        FeedSet("MISSED", "Nothing there.", invalid, 0, 0)
        return
    end if
    if tsp.protected then
        mimicking = false
        if a.abCount > 0 then mimicking = a.ab.DoesExist("cleanerMimic")
        if not mimicking then
            FeedSet("REPELLED", tsp.name + ": reef etiquette - cleaners are left alone.", invalid, 0, 0)
            return
        end if
    end if

    ' ---- diet edge: the attacker's highest-preference edge that matches one of the target's
    ' food tags (its own tags plus, for fish-like animals, a size tag from its current length)
    edge = invalid
    locked = -1
    stag = ""
    if tsp.sizetag then stag = SizeTag(t.length)
    fs = tsp.foodset
    for each e in asp.diet
        if e.tag = stag or fs.DoesExist(e.tag) then
            if milestone >= 0 and e.ms > milestone then
                if locked < 0 or e.ms < locked then locked = e.ms
            else
                ok = true
                if e.ability <> "" then ok = asp.abset.DoesExist(e.ability)
                if ok then
                    if edge = invalid then
                        edge = e
                    else if e.pref > edge.pref then
                        edge = e
                    end if
                end if
            end if
        end if
    end for
    if edge = invalid then
        if locked >= 0 then
            nm = m.bal.growth.milestonenames[locked]
            if nm = invalid then nm = "milestone " + locked.ToStr()
            FeedSet("FORBIDDEN_DIET", "Too small to hunt " + tsp.name + " yet - unlocks at " + Chr(34) + nm + Chr(34) + ".", invalid, 0, 0)
            m.fc.locked = locked
        else
            FeedSet("FORBIDDEN_DIET", tsp.name + " isn't part of the " + asp.name + "'s diet.", invalid, 0, 0)
        end if
        return
    end if

    ' ---- range / obstruction
    if not ignoreRange then
        if not contact then
            if w.time < a.lungeReadyAt and not a.lunging then
                FeedSet("COOLDOWN", "Recovering from the last lunge.", edge, 0, 0)
                return
            end if
            reach = t.radius + a.length * 0.32 + 0.08
            mx = a.x + a.hx * a.length * 0.45
            my = a.y + a.hy * a.length * 0.45
            if Dist(mx, my, t.x, t.y) > reach then
                FeedSet("MISSED", "Out of reach.", edge, 0, 0)
                return
            end if
        end if
        if t.hiddenIn >= 0 then
            sh = w.rr.shelters[t.hiddenIn]
            if a.length > sh.clearance then
                FeedSet("OBSTRUCTED", tsp.name + " is tucked inside " + ShelterPhrase(sh.kind) + " too small for you.", edge, 0, 0)
                return
            end if
        end if
        if not TerrLineOfSight(w.rr, a.x, a.y, t.x, t.y) then
            FeedSet("OBSTRUCTED", "Rock is in the way.", edge, 0, 0)
            return
        end if
    end if

    tL = t.length
    if t.inflated then tL = tL * 1.8
    aL = a.length
    if aL < 0.01 then aL = 0.01
    ratio = tL / aL
    if edge.minratio >= 0 and ratio < edge.minratio then
        FeedSet("FORBIDDEN_DIET", tsp.name + " is too small to be worth catching.", edge, 0, 0)
        return
    end if

    ' ---- toxin / venom tolerance
    tol = edge.tol
    vr = asp.venomres + a.mVenomRes
    if vr > tol then tol = vr
    if asp.immuneto <> invalid then
        for each im in asp.immuneto
            if im = tsp.id then tol = 1.0
            for each ft in tsp.foodtags
                if ft = im then tol = 1.0
            end for
        end for
    end if
    if tol < 0 then tol = 0.0
    if tol > 1 then tol = 1.0

    if t.inflated and tol < 0.95 then
        FeedSet("REPELLED", tsp.name + " puffed up into a spiny ball!", edge, 6, 0)
        return
    end if

    ' ---- armour
    armor = tsp.armor + t.mArmor
    strength = asp.bite + a.mBite
    if armor > strength + 0.05 then
        FeedSet("ARMORED", tsp.name + "'s shell is too hard for your jaws.", edge, 0, 0)
        return
    end if

    ' ---- size / gape
    resource = (t.maxCharges > 0)
    fits = (tL <= a.length * asp.gape)
    maxRatio = edge.maxratio
    if maxRatio < 0 then maxRatio = 1.8
    mode = ""
    if resource then
        tmv = tsp.mv
        if tmv <> 3 and tmv <> 4 and tsp.group <> "plant" and fits and not edge.biteonly then
            mode = "SWALLOW"
        else
            mode = "BITE"
        end if
    else if fits and (not edge.biteonly) and ratio <= maxRatio then
        mode = "SWALLOW"
    else if ratio <= maxRatio and (edge.biteonly or CanTearChunks(a) or mimicNibble) then
        mode = "BITE"
    else
        FeedSet("TOO_LARGE", tsp.name + " is too big for the " + asp.name + "'s mouth.", edge, 0, 0)
        return
    end if

    ' ---- spines
    spines = SpineLevel(t)
    spineDamage = 0.0
    if spines > tol then
        r = ratio
        if r < 0.2 then r = 0.2
        if r > 2 then r = 2.0
        spineDamage = (spines - tol * 0.5) * 30.0 * Sqr(r)
        if spines - tol >= 0.5 then
            FeedSet("REPELLED", "Ouch! " + tsp.name + "'s spines drive you off.", edge, spineDamage, 0)
            return
        end if
    end if

    ' ---- toxic flesh / stinging cells
    if tsp.tox > tol + 0.05 then
        toxinDamage = 8.0 + (tsp.tox - tol) * 30.0
        FeedSet("HARMFUL_BITE", tsp.name + " is toxic to the " + asp.name + "!", edge, spineDamage, toxinDamage)
        return
    end if

    if mode = "SWALLOW" then
        FeedSet(mode, "Swallow whole: " + tsp.name + ".", edge, spineDamage, 0)
    else
        FeedSet(mode, "Take a bite: " + tsp.name + ".", edge, spineDamage, 0)
    end if
end sub

' Energy restored by a meal.
function MealEnergy(a as object, t as object, swallow as boolean) as float
    if t.sp.hasnutrition then
        if swallow then return t.sp.nutrition * 1.5
        return t.sp.nutrition * 1.0
    end if
    edible = t.mass
    if not swallow then edible = edible * 0.35
    am = a.mass
    if am < 0.05 then am = 0.05
    e = Sqr(edible / am) * 70.0
    if e < 6 then e = 6.0
    if e > 28 then e = 28.0
    return e
end function

' Edible biomass (growth units) from a meal, before assimilation.
function MealBiomass(t as object, swallow as boolean) as float
    if t.sp.hasnutrition then
        if swallow then return t.sp.nutrition * 0.009 * 1.5
        return t.sp.nutrition * 0.009
    end if
    if swallow then return t.mass
    return t.mass * 0.35
end function

' Damage a predator's bite deals.
function BiteDamage(a as object, t as object, difficultyDamage as float) as float
    tl = t.length
    if tl < 0.05 then tl = 0.05
    ratio = (a.length * a.sp.gape) / tl
    armor = t.sp.armor + t.mArmor
    raw = 22.0 + 14.0 * ratio
    if raw < 22 then raw = 22.0
    if raw > 70 then raw = 70.0
    if armor < 0 then armor = 0.0
    if armor > 0.8 then armor = 0.8
    return raw * difficultyDamage * t.mDamage * (1 - armor * 0.5)
end function

' Is `other` dangerous to `prey`? (Exact check; used for the player and the halos.)
function IsThreatExact(w as object, other as object, prey as object, milestone as integer) as boolean
    if (not other.alive) or other.removed or other.id = prey.id then return false
    osp = other.sp
    if osp.role = "hazard" then return true
    if not osp.mobile then return false
    if other.length < prey.length * 0.5 and not osp.hasbiteonly then return false
    ms = -1
    if other.isPlayer then ms = milestone
    CheckFeed(w, other, prey, ms, true, false, false)
    r = m.fc.result
    if r = "SWALLOW" then return true
    return (r = "BITE" and prey.maxCharges <= 0)
end function
