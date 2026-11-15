' ============================================================================
' guide.brs - the Field Guide: every creature of the reef, filled in as you discover them.
' Used as a menu screen and, from the pause menu or the death screen, over a run.
' ============================================================================

function GuideFilters() as object
    return ["All", "Playable", "Fish", "Sharks and rays", "Invertebrates", "Plants and reef life"]
end function

function GuideMatches(sp as object, filter as integer) as boolean
    if filter = 0 then return true
    if filter = 1 then return (sp.playable = true)
    g = sp.group
    if filter = 2 then return (g = "fish")
    if filter = 3 then return (g = "shark" or g = "ray")
    if filter = 4 then return (g = "invertebrate" or g = "cephalopod")
    return (g = "plant" or g = "other")
end function

sub GuideEnter(focusId as string)
    known = SaveKnownSet()
    w = m.game.w
    if w <> invalid then
        for each id in w.known
            known[id] = true
        end for
    end if
    gd = { known: known, filter: 0, grid: invalid, count: 0 }
    for i = 0 to m.speciesBase - 1
        if known.DoesExist(m.species[i].id) then gd.count = gd.count + 1
    end for
    m.app.gd = gd
    GuideBuild(gd, focusId)
end sub

sub GuideBuild(gd as object, focusId as string)
    items = []
    sel = 0
    for i = 0 to m.speciesBase - 1
        sp = m.species[i]
        if GuideMatches(sp, gd.filter) then
            k = gd.known.DoesExist(sp.id)
            lbl = "???"
            if k then lbl = sp.name
            if sp.id = focusId then sel = items.Count()
            items.Push({ sp: sp, known: k, label: lbl })
        end if
    end for
    gd.grid = GridNew(items, 5, 4)
    gd.grid.sel = sel
    gd.grid.top = sel \ 5 - 1
    if gd.grid.top < 0 then gd.grid.top = 0
end sub

' Returns true when the guide should close.
function GuideInput() as boolean
    gd = m.app.gd
    for each key in m.inp.pressed
        if key = 8 or key = 9 then
            n = GuideFilters().Count()
            if key = 8 then
                gd.filter = (gd.filter + n - 1) MOD n
            else
                gd.filter = (gd.filter + 1) MOD n
            end if
            cur = ""
            if gd.grid.items.Count() > 0 then cur = gd.grid.items[gd.grid.sel].sp.id
            GuideBuild(gd, cur)
            Sfx("ui_move")
        end if
    end for
    a = GridInput(gd.grid)
    if a = "back" then
        Sfx("ui_back")
        return true
    end if
    return false
end function

function GuideNames(indices as object, known as object, maxN as integer) as string
    out = ""
    n = 0
    hidden = 0
    for each idx in indices
        if idx < m.speciesBase then
            sp = m.species[idx]
            if known.DoesExist(sp.id) then
                if n < maxN then
                    if out <> "" then out = out + ", "
                    out = out + sp.name
                end if
                n = n + 1
            else
                hidden = hidden + 1
            end if
        end if
    end for
    if n > maxN then out = out + " and " + (n - maxN).ToStr() + " more"
    if hidden > 0 then
        if out <> "" then out = out + ", plus "
        out = out + hidden.ToStr() + " undiscovered"
    end if
    if out = "" then out = "None on this reef"
    return out
end function

sub GuideDraw()
    scr = m.screen
    ui = m.ui
    gd = m.app.gd
    UiDim(170)
    UiTitle("Field Guide", gd.count.ToStr() + " of " + m.speciesBase.ToStr() + " species discovered")
    ' filter tabs
    x = 470
    fl = GuideFilters()
    for i = 0 to fl.Count() - 1
        col = ui.faint
        fill = &h0E355290
        if i = gd.filter then
            col = ui.ink
            fill = ui.rowHi
        end if
        x = x + UiTag(x, 86, fl[i], col, fill) + 6
    end for
    GridDrawSpecies(gd.grid, 48, 130, 126, 118, true)
    UiPanel(752, 124, 480, 530)
    if gd.grid.items.Count() = 0 then
        DrawTextC("Nothing here yet.", 992, 360, ui.faint, "small")
    else
        it = gd.grid.items[gd.grid.sel]
        sp = it.sp
        UiPortrait(sp, 768, 138, 200, 120, it.known)
        if it.known then
            DrawWrapped(sp.name, 980, 138, 240, ui.text, "smallb", 2)
            sci = sp.sci
            if sci = invalid then sci = ""
            if sp.fictional = true then sci = "Fictional species"
            scr.DrawText(FitText(sci, "tiny", 240), 980, 190, ui.faint, m.fonts.tiny)
            scr.DrawText(UiActivity(sp.activity), 980, 212, ui.gold, m.fonts.tiny)
            t = "Size " + Fmt1(sp.len) + "   Food web tier " + sp.tier.ToStr()
            scr.DrawText(t, 980, 234, ui.faint, m.fonts.tiny)
            y = 270
            y = DrawWrapped(sp.summary, 768, y, 448, ui.text, "tiny", 4) + 8
            scr.DrawText("EATS", 768, y, ui.aqua, m.fonts.tiny)
            y = DrawWrapped(UiDietNames(sp), 840, y, 376, ui.dim, "tiny", 3) + 4
            scr.DrawText("EATEN BY", 768, y, ui.coral, m.fonts.tiny)
            y = DrawWrapped(GuideNames(sp.predators, gd.known, 4), 870, y, 346, ui.dim, "tiny", 2) + 4
            ab = UiAbilityNames(sp)
            scr.DrawText("ABILITY", 768, y, ui.gold, m.fonts.tiny)
            y = DrawWrapped(ab, 860, y, 356, ui.dim, "tiny", 1) + 8
            if y < 560 then
                maxL = (640 - y) \ 22
                DrawWrapped(sp.fact, 768, y, 448, ui.faint, "tiny", maxL)
            end if
            ' how it relates to the fish you are playing
            w = m.game.w
            if w <> invalid and m.app.screen = "game" then
                p = w.player
                if p <> invalid and sp.idx <> invalid and p.sp.idx < m.speciesBase and sp.id <> p.sp.id then
                    n = m.species.Count()
                    md = m.eatMode[p.sp.idx * n + sp.idx]
                    t = "Your " + p.sp.name + " cannot eat it."
                    col = ui.faint
                    if md = 1 then
                        t = "Your " + p.sp.name + " can swallow it whole."
                        col = ui.good
                    else if md = 2 then
                        t = "Your " + p.sp.name + " can take bites from it."
                        col = ui.good
                    end if
                    if m.threat[sp.idx][p.sp.idx] = 1 then
                        t = "It hunts fish like your " + p.sp.name + "!"
                        col = ui.bad
                    end if
                    if w.cfg.growthMode then t = t + " (changes as you grow)"
                    scr.DrawText(FitText(t, "tiny", 448), 768, 624, col, m.fonts.tiny)
                end if
            end if
        else
            scr.DrawText("Undiscovered", 980, 150, ui.text, m.fonts.smallb)
            scr.DrawText(UiActivity(sp.activity), 980, 184, ui.faint, m.fonts.tiny)
            where = ""
            for each r in sp.rows
                if where <> "" then where = where + ", "
                if r = 0 then where = where + "the sunlit top"
                if r = 1 then where = where + "the mid reef"
                if r = 2 then where = where + "the deep floor"
            end for
            y = DrawWrapped("Look for it in " + where + ".", 768, 280, 448, ui.dim, "small")
            DrawWrapped("To add a creature to the guide: eat it, get bitten by it, or step to it with Replay (inspect) while it is on screen.", 768, y + 16, 448, ui.faint, "tiny")
        end if
    end if
    UiHints([["<< >>", "Filter"], ["Back", "Close"]])
end sub
