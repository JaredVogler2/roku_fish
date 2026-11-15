' ============================================================================
' creatorui.brs - the Reef Lab screen: design a fish within a 1,000 point budget, test it, save it.
' (The rules live in creator.brs.) Text entry is awkward on a remote, so names are picked from a
' list and the look is borrowed from an existing reef species of the same body plan.
' ============================================================================

function CreatorNames() as object
    return ["Reef Prototype", "Coral Comet", "Tide Runner", "Lagoon Ghost", "Sand Dancer", "Night Prowler", "Kelp Knight", "Azure Dart", "Ember Fin", "Moon Jaw", "Glass Arrow", "Storm Scale", "Pearl Hunter", "Deep Lantern", "Sun Chaser", "Rogue Wave"]
end function

sub CreatorEnter()
    st = { d: CreatorDefault(), form: invalid, slot: -1, msg: "", msgAt: 0 }
    m.app.st = st
    CreatorBuildForm(st, 0)
end sub

function CreatorLevels(id as string, label as string, value as integer, help as string) as object
    return { kind: "choice", id: id, label: label, values: [0, 1, 2, 3, 4], labels: ["0", "1", "2", "3", "4"], idx: value, help: help }
end function

sub CreatorBuildForm(st as object, keepSel as integer)
    d = st.d
    rows = []
    ' saved designs
    vals = [-1]
    lbls = ["New design"]
    i = 0
    for each c in m.save.custom
        vals.Push(i)
        lbls.Push(c.name)
        i = i + 1
    end for
    r = { kind: "choice", id: "slot", label: "Design", values: vals, labels: lbls, idx: 0, help: "Start a new design or load one you saved. Up to six designs are kept." }
    for i = 0 to vals.Count() - 1
        if vals[i] = st.slot then r.idx = i
    end for
    rows.Push(r)
    names = CreatorNames()
    r = { kind: "choice", id: "name", label: "Name", values: names, labels: names, idx: 0, help: "Pick a name for your fish." }
    for i = 0 to names.Count() - 1
        if names[i] = d.name then r.idx = i
    end for
    rows.Push(r)
    r = { kind: "choice", id: "archetype", label: "Body", values: ["fusiform", "deepBody", "ray", "eel", "puffer"], labels: ["Streamlined", "Deep-bodied", "Ray", "Eel", "Puffer"], idx: 0, help: "The body plan. Rays and eels cost 60 points, puffers 40. Some abilities need a particular body." }
    for i = 0 to 4
        if r.values[i] = d.archetype then r.idx = i
    end for
    rows.Push(r)
    looks = CreatorLooks(d.archetype)
    lv = []
    ll = []
    for i = 0 to looks.Count() - 1
        lv.Push(i)
        ls = GetSpecies(looks[i])
        if ls <> invalid then
            ll.Push(ls.name)
        else
            ll.Push("Look " + (i + 1).ToStr())
        end if
    end for
    li = d.look
    if li < 0 or li >= lv.Count() then li = 0
    rows.Push({ kind: "choice", id: "look", label: "Look", values: lv, labels: ll, idx: li, help: "Colours and pattern, borrowed from a reef species with the same body plan." })
    r = { kind: "choice", id: "sizeclass", label: "Size", values: ["small", "medium", "large"], labels: ["Small", "Medium (150)", "Large (350)"], idx: 0, help: "Bigger fish eat bigger prey and shrug off small hunters, but burn more energy and fit fewer hiding places." }
    for i = 0 to 2
        if r.values[i] = d.sizeclass then r.idx = i
    end for
    rows.Push(r)
    rows.Push(CreatorLevels("speed", "Speed", d.speed, "Cruising and sprint speed. 60 points a level."))
    rows.Push(CreatorLevels("endurance", "Endurance", d.endurance, "Slower energy drain. 50 points a level."))
    rows.Push(CreatorLevels("agility", "Agility", d.agility, "Tighter turns. 50 points a level."))
    rows.Push(CreatorLevels("mouth", "Mouth", d.mouth, "Wider gape and stronger bite: larger and harder prey. 60 points a level."))
    rows.Push(CreatorLevels("armor", "Armor", d.armor, "Tougher scales: less bite damage. 70 points a level."))
    r = { kind: "choice", id: "diet", label: "Diet", values: ["herbivore", "planktivore", "invertivore", "omnivore", "piscivore"], labels: ["Grazer", "Plankton feeder", "Invertebrate hunter (40)", "Omnivore (90)", "Fish eater (120)"], idx: 0, help: "What it can eat. Grazers and plankton feeders are free and never starve near algae or plankton; fish eaters score fastest." }
    for i = 0 to 4
        if r.values[i] = d.diet then r.idx = i
    end for
    rows.Push(r)
    av = ["none", "burstSprint", "illuminate", "lure", "cleanerMimic", "camouflage", "defensiveSpines", "inflate", "sting", "inkCloud", "sonicBurst", "electricPulse"]
    al = []
    costs = m.cfgData.creator.abilitycost
    for each a in av
        nm = "None"
        def = m.abilities[a]
        if def <> invalid and a <> "none" then nm = def.name + " (" + costs[LCase(a)].ToStr() + ")"
        al.Push(nm)
    end for
    r = { kind: "choice", id: "ability", label: "Ability", values: av, labels: al, idx: 0, help: "One special ability, used with the Rewind button." }
    for i = 0 to av.Count() - 1
        if av[i] = d.ability then r.idx = i
    end for
    rows.Push(r)
    r = { kind: "choice", id: "activity", label: "Active", values: ["any", "day", "night", "twilight"], labels: ["Day and night", "By day", "At night", "Dawn and dusk"], idx: 0, help: "When your fish is at its best. Out of hours it sees less far." }
    for i = 0 to 3
        if r.values[i] = d.activity then r.idx = i
    end for
    rows.Push(r)
    rows.Push({ kind: "button", id: "test", label: "Test swim", primary: true, help: "Try the design on the Lagoon Reef (Practice rules)." })
    rows.Push({ kind: "button", id: "save", label: "Save design", help: "Keep it for Practice mode." })
    if st.slot >= 0 then rows.Push({ kind: "button", id: "delete", label: "Delete this design", help: "Remove it from your saved designs." })
    f = FormNew(rows)
    if keepSel < rows.Count() then f.sel = keepSel
    FormFix(f, 1)
    st.form = f
end sub

sub CreatorRead(st as object)
    f = st.form
    d = st.d
    d.name = FormValue(f, "name")
    d.archetype = FormValue(f, "archetype")
    d.look = FormValue(f, "look")
    d.sizeclass = FormValue(f, "sizeclass")
    d.speed = FormValue(f, "speed")
    d.endurance = FormValue(f, "endurance")
    d.agility = FormValue(f, "agility")
    d.mouth = FormValue(f, "mouth")
    d.armor = FormValue(f, "armor")
    d.diet = FormValue(f, "diet")
    d.ability = FormValue(f, "ability")
    d.activity = FormValue(f, "activity")
end sub

sub CreatorInput()
    st = m.app.st
    f = st.form
    a = FormInput(f)
    if a = "" then return
    if a = "back" then
        Sfx("ui_back")
        AppGoto("menu")
        return
    end if
    if a = "~slot" then
        slot = FormValue(f, "slot")
        st.slot = slot
        if slot < 0 then
            st.d = CreatorDefault()
        else
            src = m.save.custom[slot]
            nd = {}
            for each k in src
                nd[k] = src[k]
            end for
            st.d = nd
        end if
        CreatorBuildForm(st, f.sel)
        return
    end if
    if Left(a, 1) = "~" then
        prevBody = st.d.archetype
        CreatorRead(st)
        if st.d.archetype <> prevBody then
            st.d.look = 0
            CreatorBuildForm(st, f.sel)
        end if
        return
    end if
    issues = CreatorValidate(st.d)
    if a = "test" or a = "save" then
        if issues.Count() > 0 then
            st.msg = "Fix the design first: " + issues[0]
            st.msgAt = NowMs()
            Sfx("ui_error")
            return
        end if
    end if
    if a = "test" then
        po = { timeOfDay: "cycle", region: "reef", predators: 1.0, prey: 1.0, hazards: 1.0, infiniteEnergy: false, invulnerable: false }
        AppStartRun({ mode: "practice", customFish: st.d, practice: po })
    else if a = "save" then
        list = m.save.custom
        if st.slot >= 0 and st.slot < list.Count() then
            list[st.slot] = st.d
        else if list.Count() >= 6 then
            st.msg = "Six designs are saved already - load one and replace or delete it."
            st.msgAt = NowMs()
            Sfx("ui_error")
            return
        else
            list.Push(st.d)
            st.slot = list.Count() - 1
        end if
        SaveWrite()
        st.msg = "Saved. Find it at the top of the Practice list."
        st.msgAt = NowMs()
        CreatorBuildForm(st, f.sel)
    else if a = "delete" then
        if st.slot >= 0 and st.slot < m.save.custom.Count() then
            m.save.custom.Delete(st.slot)
            SaveWrite()
        end if
        st.slot = -1
        st.d = CreatorDefault()
        st.msg = "Design deleted."
        st.msgAt = NowMs()
        CreatorBuildForm(st, 0)
    end if
end sub

sub CreatorDraw()
    scr = m.screen
    ui = m.ui
    st = m.app.st
    d = st.d
    UiDim(140)
    UiTitle("Reef Lab", "Design a fish with a 1,000 point budget")
    UiPanel(48, 124, 560, 524)
    sp = CustomFishSpecies(d)
    UiPortrait(sp, 66, 140, 250, 150)
    scr.DrawText(FitText(d.name, "bodyb", 260), 332, 142, ui.text, m.fonts.bodyb)
    cost = CreatorCost(d)
    budget = m.cfgData.creator.budget
    col = ui.good
    if cost > budget then col = ui.bad
    scr.DrawText(cost.ToStr() + " / " + budget.ToStr() + " points", 332, 182, col, m.fonts.smallb)
    UiBar(332, 214, 256, 12, cost / budget, col)
    scr.DrawText(FitText(UiAbilityNames(sp), "tiny", 256), 332, 240, ui.gold, m.fonts.tiny)
    scr.DrawText(UiActivity(d.activity), 332, 264, ui.faint, m.fonts.tiny)
    ' derived numbers
    y = 308
    stats = [
        ["Length", Fmt2(sp.len)], ["Health", Int(sp.health).ToStr()]
        ["Cruise speed", Fmt1(sp.swim)], ["Sprint speed", Fmt1(sp.burst)]
        ["Agility", UiPercent(sp.agility)], ["Bite", UiPercent(sp.bite)]
        ["Gape", UiPercent(sp.gape)], ["Armor", UiPercent(sp.armor)]
    ]
    i = 0
    for each s in stats
        x = 66 + (i MOD 2) * 268
        yy = y + (i \ 2) * 30
        scr.DrawText(s[0], x, yy, ui.faint, m.fonts.tiny)
        DrawTextR(s[1], x + 244, yy, ui.text, "tiny")
        i = i + 1
    end for
    y = y + 4 * 30 + 6
    scr.DrawText("EATS", 66, y, ui.aqua, m.fonts.tiny)
    y = DrawWrapped(UiDietNames(sp), 130, y, 460, ui.dim, "tiny", 2) + 8
    issues = CreatorValidate(d)
    if issues.Count() = 0 then
        scr.DrawText("This design is valid.", 66, y, ui.good, m.fonts.tiny)
    else
        n = 0
        for each iss in issues
            if n < 3 then y = DrawWrapped("! " + iss, 66, y, 524, ui.bad, "tiny", 2)
            n = n + 1
        end for
    end if
    note = FormNote(st.form)
    if st.msg <> "" and NowMs() - st.msgAt < 3500 then note = st.msg
    if note <> "" then DrawWrapped(note, 66, 580, 524, ui.dim, "tiny", 3)
    UiPanel(628, 124, 604, 524)
    FormDraw(st.form, 646, 142, 568, 494)
    UiHints([["< >", "Change"], ["OK", "Select"], ["Back", "Menu"]])
end sub
