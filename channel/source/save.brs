' ============================================================================
' save.brs - progress and settings in the Roku registry (one JSON document, a few KB).
' Missing or unreadable data falls back to defaults; newer fields are filled in on load.
' ============================================================================

function SaveDefault() as object
    return {
        version: 1
        settings: {
            music: true
            sfx: true
            shake: true
            halos: true
            hints: true
            rules: "balanced"
            difficulty: "standard"
            classicchomp: false
            detail: "auto"
        }
        tutorialseen: false
        discovered: []
        tournament: invalid
        challenge: []
        custom: []
        ascension: invalid
        unlocked: ["reef"]
        best: { length: 0.0, score: 0, stage: 0, longest: 0 }
        totals: { runs: 0, deaths: 0, eaten: 0 }
    }
end function

sub SaveLoad()
    d = SaveDefault()
    m.saveOk = true
    sec = CreateObject("roRegistrySection", "reefbound")
    if sec = invalid then
        m.saveOk = false
        m.save = d
        return
    end if
    txt = ""
    if sec.Exists("save") then txt = sec.Read("save")
    if txt <> "" then
        j = ParseJson(txt)
        if j <> invalid then
            if type(j) = "roAssociativeArray" then
                for each k in d
                    if j[k] <> invalid then
                        if k = "settings" or k = "best" or k = "totals" then
                            for each k2 in d[k]
                                if j[k][k2] <> invalid then d[k][k2] = j[k][k2]
                            end for
                        else
                            d[k] = j[k]
                        end if
                    end if
                end for
            end if
        end if
    end if
    ' never restore impossible values
    if d.ascension <> invalid then
        ok = false
        if type(d.ascension) = "roAssociativeArray" then
            if d.ascension.mass <> invalid then ok = (d.ascension.mass >= 1 and d.ascension.mass <= 64)
        end if
        if not ok then d.ascension = invalid
    end if
    if not ArrayHas(d.unlocked, "reef") then d.unlocked.Unshift("reef")
    m.save = d
end sub

sub SaveWrite()
    if not m.saveOk then return
    sec = CreateObject("roRegistrySection", "reefbound")
    if sec = invalid then return
    txt = FormatJson(m.save)
    if txt = invalid or txt = "" then return
    sec.Write("save", txt)
    sec.Flush()
end sub

sub SaveReset()
    m.save = SaveDefault()
    SaveWrite()
end sub

function SaveKnownSet() as object
    k = {}
    for each id in m.save.discovered
        k[id] = true
    end for
    return k
end function

sub SaveDiscover(id as string)
    if not ArrayHas(m.save.discovered, id) then m.save.discovered.Push(id)
end sub
