' ============================================================================
' creature.brs - runtime state of one animal or food organism.
'
' Creatures are plain associative arrays (no methods: BrightScript method calls are slow and
' rebind m). Timers are stored as absolute simulation times ("...Until", "...At") so nothing has
' to count them down every tick.
' ============================================================================

' behaviour codes
function BhWander() as integer
    return 0
end function
function BhSchool() as integer
    return 1
end function
function BhForage() as integer
    return 2
end function
function BhPursue() as integer
    return 3
end function
function BhFlee() as integer
    return 4
end function
function BhHide() as integer
    return 5
end function
function BhClean() as integer
    return 6
end function
function BhRest() as integer
    return 7
end function
function BhStunned() as integer
    return 8
end function
function BhAmbush() as integer
    return 10
end function
function BhCrawl() as integer
    return 11
end function
function BhDrift() as integer
    return 12
end function
function BhSearch() as integer
    return 13
end function
function BhVisitCleaner() as integer
    return 14
end function
function BhIdle() as integer
    return 15
end function

function BehaviorName(b as integer) as string
    names = ["wandering", "schooling", "foraging", "hunting", "fleeing", "hiding", "cleaning", "resting", "stunned", "attacking", "lying in ambush", "crawling", "drifting", "searching", "visiting a cleaner", "still"]
    if b < 0 or b >= names.Count() then return ""
    return names[b]
end function

function CreatureNew(id as integer, sp as object, x as float, y as float, sizeMul as float) as object
    length = sp.len * sizeMul
    c = {
        id: id
        sp: sp
        sidx: sp.idx
        isPlayer: false
        x: x, y: y
        vx: 0.0, vy: 0.0
        hx: 1.0, hy: 0.0        ' unit heading vector (the way the body points)
        turnRate: (2.2 + sp.agility * 6) / (1 + 0.12 * length)
        simAt: 0.0, pAt: 0.0    ' times of the current and previous movement states (render interpolation)
        px: x, py: y            ' previous tick position (render interpolation)
        sector: 0
        sizeMul: sizeMul
        length: length          ' logical body length used by every rule
        vlen: length            ' smoothed length for drawing
        radius: length * sp.rf
        mass: sp.mass * sizeMul * sizeMul * sizeMul
        energy: 100.0
        maxEnergy: 100.0
        health: sp.health * 1.0
        maxHealth: sp.health * 1.0
        alive: true
        removed: false
        diedAt: 0.0
        behavior: 0
        bsince: 0.0             ' time the current behaviour started
        targetId: -1
        threatId: -1
        lastSeenX: 0.0, lastSeenY: 0.0, lastSeenAt: -999.0
        ignoreId: -1
        ignoreUntil: 0.0
        wanderX: x, wanderY: y
        wanderOk: true          ' false = flee straight away from the threat
        homeSector: 0
        homeX: x, homeY: y
        cd: {}                  ' ability id -> time it is ready again
        visibility: 1.0
        hiddenIn: -1            ' shelter index or -1
        venom: 0.0
        wound: 0.0
        hungryAt: 0.0           ' NPC predators hunt only after this time
        stunUntil: 0.0
        inkUntil: 0.0
        freezeUntil: 0.0
        lungeUntil: 0.0
        lunging: false
        lungeReadyAt: 0.0
        lungeTargetId: -1
        invulnUntil: 0.0
        charges: sp.charges     ' bite-only resources (plankton, coral, algae, brittle star arms)
        maxCharges: sp.charges
        chargeAt: 0.0
        surface: invalid        ' crawl surface the animal walks on
        crawlDir: 1
        schoolId: 0
        nextThink: 0.0
        cleanT: 0.0
        cleanStation: -1
        inflateK: 0.0           ' drawing: how far a puffer is blown up (0..1, eased)
        ab: {}                  ' active ability id -> end time
        abCount: 0
        lastDmgSpecies: ""
        lastDmgCause: ""
        slot: invalid
        timesBitten: 0
        lastBittenAt: -999.0
        biteAt: -9.0, attackAt: -9.0, hurtAt: -9.0
        speedNorm: 0.0
        burstUntil: 0.0
        steerX: 0.0, steerY: 0.0
        wantBurst: false
        clear: 0.0              ' cached distance to terrain minus radius
        stuckAt: 0.0
        progX: x, progY: y
        huntStart: 0.0
        calmUntil: 0.0
        hideUntil: 0.0
        active: false           ' inside the simulated bubble around the camera
        dormAt: 0.0
        groundY: -1.0           ' for seabed organisms: where they touch the ground
        ' multipliers from upgrades / Reef Lab designs
        mSpeed: 1.0, mBurst: 1.0, mAgility: 1.0, mPerception: 1.0, mDrain: 1.0
        mArmor: 0.0, mVenomRes: 0.0, mBite: 0.0, mDamage: 1.0, mSprintDrain: 1.0, mLungeCd: 1.0, mSpines: 0.0
        inflated: false
        ' cached verdicts about the player (refreshed when the player changes size or state)
        pvStamp: -1
        pvThreat: false         ' is the player a threat to this animal
        pvEat: 0                ' 0 cannot eat the player, 1 swallow, 2 bite
        pvRisk: 0               ' halo class for the player looking at this animal
        pvPref: 0.0, pvSpine: 0.0, pvVal: 0.0, pvFSpine: 0.0
        pvResult: "", pvReason: ""
        pvEdible: false
        school: invalid         ' shared record of the school: { x, y, until, members }
        station: invalid        ' cleaners: the cleaning station they work at
        schX: 0.0, schY: 0.0, schOk: false
        scanAt: 0.0             ' next time a hungry animal looks for prey
        period: 3               ' movement update period in ticks (see BrainSetPeriod)
        visN: 0
        probeFlip: false
        steerFlip: false
        avX: 0.0, avY: 0.0
        ' drawing state
        phase: 0.0
        face: 1.0               ' +1 facing right, -1 left (eases through 0 when turning)
        faceTo: 1.0
        pitch: 0.0
        seed: (id * 37) MOD 101
        spr: invalid            ' sprite definition (looked up on first draw)
        scrX: 0, scrY: 0        ' screen position this frame
    }
    if sp.mv = 3 then c.behavior = 15
    return c
end function

sub CreatureSetLength(c as object, length as float)
    c.length = length
    c.radius = length * c.sp.rf
    c.turnRate = (2.2 + c.sp.agility * 6) * c.mAgility / (1 + 0.12 * length)
end sub

' Apparent length: an inflated puffer looks - and is - much bigger to predators.
function CreatureEffLength(c as object) as float
    if c.inflated then return c.length * 1.8
    return c.length
end function

' Current food charges of a renewable resource (regrowth is applied lazily).
function CreatureCharges(c as object, now as float) as integer
    if c.maxCharges <= 0 then return 0
    if c.charges < c.maxCharges then
        regen = c.sp.regen
        if regen > 0 then
            gained = Int((now - c.chargeAt) * regen / 60.0)
            if gained > 0 then
                c.charges = c.charges + gained
                c.chargeAt = c.chargeAt + gained * 60.0 / regen
                if c.charges >= c.maxCharges then c.charges = c.maxCharges
            end if
        end if
    else
        c.chargeAt = now
    end if
    return c.charges
end function

function HasAbility(c as object, id as string) as boolean
    if c.abCount = 0 then return false
    return c.ab.DoesExist(id)
end function

function CooldownLeft(c as object, id as string, now as float) as float
    t = c.cd[id]
    if t = invalid then return 0.0
    if t <= now then return 0.0
    return t - now
end function

sub SetBehavior(c as object, b as integer, now as float)
    if c.behavior <> b then
        c.behavior = b
        c.bsince = now
    end if
end sub
