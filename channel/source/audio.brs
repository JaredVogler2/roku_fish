' ============================================================================
' audio.brs - sound effects (roAudioResource, WAV) and looping music (roAudioPlayer, MP3).
' All audio was synthesised offline for this project by tools/audio (no samples).
' ============================================================================

sub AudioInit()
    m.aud = {
        sfx: {}
        vol: {}
        last: {}
        player: invalid
        track: ""
        sfxOn: true
        musicOn: true
        streams: 1
        slot: 0
    }
    meta = ReadJson("pkg:/sounds/sounds.json")
    if meta = invalid then return
    m.aud.meta = meta
    if meta.sfx <> invalid then
        for each id in meta.sfx
            e = meta.sfx[id]
            res = CreateObject("roAudioResource", "pkg:/sounds/" + e.file)
            if res <> invalid then
                m.aud.sfx[id] = res
                v = 70
                if e.vol <> invalid then v = e.vol
                m.aud.vol[id] = v
                m.aud.last[id] = -10000
                n = res.MaxSimulStreams()
                if n > m.aud.streams then m.aud.streams = n
            end if
        end for
    end if
    m.aud.player = CreateObject("roAudioPlayer")
end sub

' Play an effect. gain 0..1 scales the mixed volume; the same effect is not retriggered within
' 70 ms so a feeding school does not machine-gun the speaker.
sub Sfx(id as string, gain = 1.0 as float)
    a = m.aud
    if a = invalid then return
    if not a.sfxOn then return
    res = a.sfx[id]
    if res = invalid then return
    now = NowMs()
    if now - a.last[id] < 70 then return
    a.last[id] = now
    v = Int(a.vol[id] * gain)
    if v < 1 then return
    if v > 100 then v = 100
    ' rotate through the device's mixing streams so overlapping effects do not cut each other off
    a.slot = (a.slot + 1) MOD a.streams
    res.Trigger(v, a.slot)
end sub

' Switch the looping music track ("reef", "deep" or "" for silence).
sub MusicPlay(track as string)
    a = m.aud
    if a = invalid then return
    if a.player = invalid then return
    if not a.musicOn then track = ""
    if track = a.track then return
    a.track = track
    a.player.Stop()
    if track = "" then return
    if a.meta = invalid then return
    if a.meta.music = invalid then return
    e = a.meta.music[track]
    if e = invalid then return
    a.player.SetContentList([{ url: "pkg:/sounds/" + e.file, streamformat: "mp3" }])
    a.player.SetLoop(true)
    a.player.SetNext(0)
    a.player.Play()
end sub

sub AudioApplySettings(sfxOn as boolean, musicOn as boolean)
    a = m.aud
    if a = invalid then return
    a.sfxOn = sfxOn
    wasOn = a.musicOn
    a.musicOn = musicOn
    if not musicOn then
        MusicPlay("")
    else if not wasOn then
        a.track = ""
    end if
end sub
