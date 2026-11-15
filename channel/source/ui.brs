' ============================================================================
' ui.brs - interface building blocks: panels, buttons, option forms, species grids, portraits.
'
' A TV interface is driven by a D-pad, so everything is a list or a grid with one focused item.
' Two small models cover every screen:
'   form  a vertical list of rows - buttons, left/right choices, toggles (menus, settings, setup)
'   grid  a scrolling grid of cards (species pickers, the Field Guide)
' Layout keeps to the 1280x720 title-safe area (64 px left/right, 36 px top/bottom).
' ============================================================================

sub UiInit()
    m.ui = {
        panel: &h04182CE0
        panel2: &h0A2B45E6
        row: &h10395AD0
        rowHi: &hFFE58AFF
        edge: &hAEEBFF38
        text: &hEEF9FFFF
        dim: &hB4D2E0FF
        faint: &h86AABEFF
        ink: &h06203AFF
        gold: &hFFD86AFF
        aqua: &h5FE3F0FF
        coral: &hFF7F8EFF
        good: &h7CFFB0FF
        warn: &hFFC850FF
        bad: &hFF6464FF
        t: 0.0
    }
end sub

' ---------------------------------------------------------------- shapes
sub UiRound(x as integer, y as integer, w as integer, h as integer, color as integer)
    scr = m.screen
    if h < 28 or w < 28 or m.spr["ui_c_tl"] = invalid then
        scr.DrawRect(x, y, w, h, color)
        return
    end if
    scr.DrawRect(x + 14, y, w - 28, 14, color)
    scr.DrawRect(x, y + 14, w, h - 28, color)
    scr.DrawRect(x + 14, y + h - 14, w - 28, 14, color)
    sp = m.spr
    scr.DrawObject(x, y, sp["ui_c_tl"].parts[0].r0, color)
    scr.DrawObject(x + w - 14, y, sp["ui_c_tr"].parts[0].r0, color)
    scr.DrawObject(x, y + h - 14, sp["ui_c_bl"].parts[0].r0, color)
    scr.DrawObject(x + w - 14, y + h - 14, sp["ui_c_br"].parts[0].r0, color)
end sub

sub UiPanel(x as integer, y as integer, w as integer, h as integer)
    UiRound(x, y, w, h, m.ui.panel)
    m.screen.DrawRect(x + 14, y + 1, w - 28, 1, m.ui.edge)
end sub

sub UiDim(alpha as integer)
    m.screen.DrawRect(0, 0, 1280, 720, &h02101E00 + alpha)
end sub

sub UiBar(x as integer, y as integer, w as integer, h as integer, frac as float, color as integer)
    scr = m.screen
    scr.DrawRect(x, y, w, h, &h00101C90)
    if frac > 1 then frac = 1.0
    if frac > 0.005 then
        fw = Int(w * frac)
        if fw < 2 then fw = 2
        scr.DrawRect(x, y, fw, h, color)
        scr.DrawRect(x, y, fw, 2, &hFFFFFF48)
    end if
end sub

' A small rounded label. Returns its width.
function UiTag(x as integer, y as integer, text as string, color as integer, fill = &h0E3552E0 as integer) as integer
    w = TextWidth(text, "tiny") + 20
    UiRound(x, y, w, 28, fill)
    m.screen.DrawText(text, x + 10, y + 4, color, m.fonts.tiny)
    return w
end function

sub UiIcon(id as string, cx as integer, cy as integer, scale as float, color as integer)
    s = m.spr[id]
    if s = invalid then return
    if scale = 1.0 then
        m.screen.DrawObject(cx, cy, s.parts[0].r0, color)
    else
        m.screen.DrawScaledObject(cx, cy, scale, scale, s.parts[0].r0, color)
    end if
end sub

' ---------------------------------------------------------------- headings and key legends
sub UiTitle(text as string, subText = "" as string)
    DrawTextShadow(text, 64, 34, m.ui.text, "big")
    if subText <> "" then DrawTextShadow(subText, 66, 86, m.ui.dim, "small")
end sub

' Bottom legend: pairs of [button, meaning], e.g. [["OK", "Select"], ["Back", "Menu"]].
sub UiHints(pairs as object)
    x = 64
    y = 664
    scr = m.screen
    for each p in pairs
        kw = TextWidth(p[0], "tiny") + 18
        UiRound(x, y, kw, 28, &hEAF8FFE8)
        scr.DrawText(p[0], x + 9, y + 4, m.ui.ink, m.fonts.tiny)
        x = x + kw + 8
        DrawTextShadow(p[1], x, y + 2, m.ui.dim, "small")
        x = x + TextWidth(p[1], "small") + 26
    end for
end sub

' ---------------------------------------------------------------- portraits
' Fit a creature's sprite (neutral pose) into a box. known = false draws a dark silhouette.
sub UiPortrait(sp as object, x as integer, y as integer, w as integer, h as integer, known = true as boolean, back = true as boolean)
    if back then
        UiRound(x, y, w, h, &h0B3A5CC8)
        m.screen.DrawRect(x + 14, y + h - 3, w - 28, 2, &h7FE0FF30)
    end if
    if sp = invalid then return
    s = m.spr[sp.sprite]
    if s = invalid then return
    bx = s.box
    bw = bx[2] - bx[0]
    bh = bx[3] - bx[1]
    if bw < 1 or bh < 1 then return
    k = (w * 0.86) / bw
    k2 = (h * 0.82) / bh
    if k2 < k then k = k2
    if k > 1.4 then k = 1.4
    cx = x + w \ 2 - Int((bx[0] + bx[2]) * 0.5 * k)
    cy = y + h \ 2 - Int((bx[1] + bx[3]) * 0.5 * k)
    col = -1
    if not known then col = &h061A2CFF
    DrawSprWhole(sp.sprite, cx, cy, k, col)
    if not known then DrawTextC("?", x + w \ 2, y + h \ 2 - 20, &h9FD8F0C0, "head")
end sub

' ---------------------------------------------------------------- forms
' A row is one of:
'   { kind: "button", id, label, note }
'   { kind: "choice", id, label, values: [...], labels: [...], idx, note }
'   { kind: "toggle", id, label, value, note }
'   { kind: "text",   label }            (not focusable)
function FormNew(rows as object) as object
    f = { rows: rows, sel: 0, top: 0 }
    FormFix(f, 1)
    return f
end function

function FormRow(f as object, id as string) as dynamic
    for each r in f.rows
        if r.id <> invalid then
            if r.id = id then return r
        end if
    end for
    return invalid
end function

function FormValue(f as object, id as string) as dynamic
    r = FormRow(f, id)
    if r = invalid then return invalid
    if r.kind = "choice" then return r.values[r.idx]
    if r.kind = "toggle" then return r.value
    return invalid
end function

sub FormSetChoice(f as object, id as string, value as dynamic)
    r = FormRow(f, id)
    if r = invalid then return
    for i = 0 to r.values.Count() - 1
        if r.values[i] = value then r.idx = i
    end for
end sub

function FormFocusable(r as object) as boolean
    if r.kind = "text" then return false
    if r.disabled = true then return false
    return true
end function

' Move the selection to the nearest focusable row in direction dir.
sub FormFix(f as object, dir as integer)
    n = f.rows.Count()
    if n = 0 then return
    i = f.sel
    tries = 0
    while tries < n
        if i < 0 then i = n - 1
        if i >= n then i = 0
        if FormFocusable(f.rows[i]) then
            f.sel = i
            return
        end if
        i = i + dir
        tries = tries + 1
    end while
end sub

' Feed this frame's key presses to a form. Returns "" or:
'   the id of a button that was pressed, "~" + id when a choice or toggle changed, "back" on Back.
function FormInput(f as object) as string
    out = ""
    for each key in m.inp.pressed
        k = key MOD 1000
        if k = 2 then
            f.sel = f.sel - 1
            FormFix(f, -1)
            Sfx("ui_move")
        else if k = 3 then
            f.sel = f.sel + 1
            FormFix(f, 1)
            Sfx("ui_move")
        else if k = 0 and key < 1000 then
            out = "back"
        else if f.rows.Count() > 0 then
            r = f.rows[f.sel]
            if r.kind = "button" then
                if k = 6 and key < 1000 then
                    Sfx("ui_select")
                    out = r.id
                end if
            else if r.kind = "choice" then
                n = r.values.Count()
                if k = 4 then
                    r.idx = (r.idx + n - 1) MOD n
                    Sfx("ui_move")
                    out = "~" + r.id
                else if k = 5 or (k = 6 and key < 1000) then
                    r.idx = (r.idx + 1) MOD n
                    Sfx("ui_move")
                    out = "~" + r.id
                end if
            else if r.kind = "toggle" then
                if k = 4 or k = 5 or (k = 6 and key < 1000) then
                    if key < 1000 then
                        r.value = not r.value
                        Sfx("ui_select")
                        out = "~" + r.id
                    end if
                end if
            end if
        end if
    end for
    return out
end function

function FormRowHeight(r as object) as integer
    if r.kind = "text" then return 34
    if r.big = true then return 78
    if r.note <> invalid and r.kind = "button" then return 64
    return 50
end function

' Draw a form in a column. maxH limits the visible height (rows scroll to keep the focus in view).
sub FormDraw(f as object, x as integer, y as integer, w as integer, maxH = 600 as integer, active = true as boolean)
    scr = m.screen
    ui = m.ui
    rows = f.rows
    n = rows.Count()
    ' keep the selection visible
    if f.sel < f.top then f.top = f.sel
    while true
        used = 0
        for i = f.top to f.sel
            used = used + FormRowHeight(rows[i]) + 8
        end for
        if used <= maxH or f.top >= f.sel then exit while
        f.top = f.top + 1
    end while
    cy = y
    i = f.top
    while i < n
        r = rows[i]
        h = FormRowHeight(r)
        if cy + h > y + maxH then exit while
        focused = (i = f.sel and active)
        if r.kind = "text" then
            scr.DrawText(r.label, x + 4, cy + 6, ui.faint, m.fonts.tiny)
        else
            fill = ui.row
            fg = ui.text
            sub2 = ui.dim
            if r.primary = true then fill = &h1C6E96E6
            if focused then
                UiRound(x - 4, cy - 4, w + 8, h + 8, &hFFE58A50)
                fill = ui.rowHi
                fg = ui.ink
                sub2 = &h23445CFF
            end if
            UiRound(x, cy, w, h, fill)
            if r.kind = "button" then
                tx = x + 20
                if r.icon <> invalid then
                    ic = &hEEF9FFFF
                    if focused then ic = ui.ink
                    UiIcon(r.icon, x + 34, cy + h \ 2, 0.5, ic)
                    tx = x + 62
                end if
                if r.note <> invalid then
                    fk = "bodyb"
                    if r.big = true then fk = "head"
                    ty = cy + 8
                    if r.big = true then ty = cy + 10
                    scr.DrawText(r.label, tx, ty, fg, m.fonts[fk])
                    scr.DrawText(FitText(r.note, "tiny", w - (tx - x) - 16), tx, cy + h - 27, sub2, m.fonts.tiny)
                else
                    scr.DrawText(r.label, tx, cy + (h - m.fontH.bodyb) \ 2, fg, m.fonts.bodyb)
                end if
            else
                scr.DrawText(r.label, x + 20, cy + (h - m.fontH.body) \ 2, fg, m.fonts.body)
                v = ""
                if r.kind = "choice" then
                    v = r.labels[r.idx]
                else
                    v = "Off"
                    if r.value then v = "On"
                end if
                vw = TextWidth(v, "bodyb")
                vx = x + w - 44 - vw
                scr.DrawText(v, vx, cy + (h - m.fontH.bodyb) \ 2, fg, m.fonts.bodyb)
                if focused then
                    scr.DrawText("<", vx - 26, cy + (h - m.fontH.bodyb) \ 2, fg, m.fonts.bodyb)
                    scr.DrawText(">", x + w - 30, cy + (h - m.fontH.bodyb) \ 2, fg, m.fonts.bodyb)
                end if
            end if
        end if
        cy = cy + h + 8
        i = i + 1
    end while
    ' scroll cues
    if f.top > 0 then DrawTextC("^", x + w \ 2, y - 22, ui.dim, "small")
    if i < n then DrawTextC("v", x + w \ 2, y + maxH - 4, ui.dim, "small")
end sub

' The note of the focused row (shown as help text beside a form).
function FormNote(f as object) as string
    if f.rows.Count() = 0 then return ""
    r = f.rows[f.sel]
    if r.help <> invalid then return r.help
    return ""
end function

' ---------------------------------------------------------------- grids
function GridNew(items as object, cols as integer, rowsVisible as integer) as object
    return { items: items, cols: cols, vis: rowsVisible, sel: 0, top: 0 }
end function

' Returns "" or "ok", "back", "left" (focus left the grid on its left edge), "right".
function GridInput(g as object) as string
    out = ""
    n = g.items.Count()
    if n = 0 then
        for each key in m.inp.pressed
            if key = 0 then out = "back"
            if key MOD 1000 = 5 then out = "right"
            if key MOD 1000 = 4 then out = "left"
        end for
        return out
    end if
    cols = g.cols
    for each key in m.inp.pressed
        k = key MOD 1000
        s = g.sel
        if k = 4 then
            if s MOD cols = 0 then
                out = "left"
            else
                g.sel = s - 1
                Sfx("ui_move")
            end if
        else if k = 5 then
            if s MOD cols = cols - 1 or s = n - 1 then
                out = "right"
            else
                g.sel = s + 1
                Sfx("ui_move")
            end if
        else if k = 2 then
            if s - cols >= 0 then
                g.sel = s - cols
                Sfx("ui_move")
            else
                out = "up"
            end if
        else if k = 3 then
            if s + cols < n then
                g.sel = s + cols
                Sfx("ui_move")
            else if (s \ cols) < ((n - 1) \ cols) then
                g.sel = n - 1
                Sfx("ui_move")
            end if
        else if k = 6 and key < 1000 then
            Sfx("ui_select")
            out = "ok"
        else if k = 0 and key < 1000 then
            out = "back"
        end if
    end for
    row = g.sel \ cols
    if row < g.top then g.top = row
    if row >= g.top + g.vis then g.top = row - g.vis + 1
    return out
end function

' Species cards. items: [{ sp, known, label, sub }]
sub GridDrawSpecies(g as object, x as integer, y as integer, cellW as integer, cellH as integer, active as boolean)
    scr = m.screen
    ui = m.ui
    n = g.items.Count()
    cols = g.cols
    first = g.top * cols
    last = first + g.vis * cols - 1
    if last > n - 1 then last = n - 1
    for i = first to last
        it = g.items[i]
        cx = x + (i MOD cols) * (cellW + 10)
        cy = y + ((i \ cols) - g.top) * (cellH + 10)
        focused = (i = g.sel and active)
        fill = &h0C3250D8
        if it.picked = true then fill = &h1C6E96E6
        if focused then
            UiRound(cx - 4, cy - 4, cellW + 8, cellH + 8, &hFFE58AFF)
            fill = &h154A70FF
        end if
        UiRound(cx, cy, cellW, cellH, fill)
        UiPortrait(it.sp, cx + 6, cy + 6, cellW - 12, cellH - 40, it.known, false)
        nm = it.label
        col = ui.text
        if not it.known then col = ui.faint
        scr.DrawText(FitText(nm, "tiny", cellW - 14), cx + 8, cy + cellH - 31, col, m.fonts.tiny)
    end for
    rowsTotal = (n + cols - 1) \ cols
    if rowsTotal > g.vis then
        ' scroll bar
        trackH = g.vis * (cellH + 10) - 10
        bx = x + cols * (cellW + 10) + 2
        scr.DrawRect(bx, y, 5, trackH, &h0E355280)
        th = Int(trackH * g.vis / rowsTotal)
        ty = y + Int((trackH - th) * g.top / (rowsTotal - g.vis))
        scr.DrawRect(bx, ty, 5, th, &h8FE3FFC0)
    end if
end sub

' ---------------------------------------------------------------- small helpers
function UiPercent(v as float) as string
    return Int(v * 100 + 0.5).ToStr() + "%"
end function

function UiTime(sec as float) as string
    s = Int(sec)
    return (s \ 60).ToStr() + ":" + Pad2(s MOD 60)
end function

function UiActivity(a as string) as string
    if a = "day" then return "Active by day"
    if a = "night" then return "Active at night"
    if a = "twilight" then return "Active at dawn and dusk"
    return "Active day and night"
end function

function AbilityDef(id as string) as dynamic
    return m.abilities[id]
end function

function UiAbilityNames(sp as object) as string
    out = ""
    for each a in sp.abilities
        if a <> "none" then
            d = AbilityDef(a)
            if d <> invalid then
                if out <> "" then out = out + ", "
                out = out + d.name
            end if
        end if
    end for
    if out = "" then out = "No special ability"
    return out
end function

function UiDietNames(sp as object) as string
    out = ""
    seen = {}
    for each d in sp.diet
        lbl = m.foodLabels[LCase(d.tag)]
        if lbl = invalid then lbl = d.tag
        if not seen.DoesExist(lbl) then
            seen[lbl] = true
            if out <> "" then out = out + ", "
            out = out + lbl
        end if
    end for
    if out = "" then out = "Nothing (it makes its own food or filters the water)"
    return out
end function
