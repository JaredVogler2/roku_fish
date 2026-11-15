' ============================================================================
' input.brs - Roku remote handling.
'
' roScreen delivers one press and one release event per button (no auto-repeat), so held state is
' tracked here. Menus get their own key repeat; gameplay reads the held D-pad as a direction.
'
' Remote layout used by the game:
'   D-pad      swim / move focus          OK        bite or chase the nearest prey / confirm
'   Rewind     ability                    Fast-fwd  sprint (hold)
'   * (info)   second ability             Replay    inspect the nearest creature
'   Play/Pause pause menu                 Back      pause menu / go back
' ============================================================================

function KeyBack() as integer
    return 0
end function
function KeyUp() as integer
    return 2
end function
function KeyDown() as integer
    return 3
end function
function KeyLeft() as integer
    return 4
end function
function KeyRight() as integer
    return 5
end function
function KeyOk() as integer
    return 6
end function
function KeyReplay() as integer
    return 7
end function
function KeyRev() as integer
    return 8
end function
function KeyFwd() as integer
    return 9
end function
function KeyInfo() as integer
    return 10
end function
function KeyPlay() as integer
    return 13
end function

sub InputInit()
    held = []
    for i = 0 to 31
        held.Push(false)
    end for
    m.inp = {
        held: held          ' is the button down right now
        pressed: []         ' buttons that went down this frame (in order)
        repeatKey: -1       ' D-pad key currently auto-repeating in menus
        repeatAt: 0
        any: false
    }
end sub

' Drain the message port. Returns false when the channel should exit (screen closed).
function InputPoll() as boolean
    inp = m.inp
    inp.pressed = []
    port = m.port
    msg = port.GetMessage()
    while msg <> invalid
        t = type(msg)
        if t = "roUniversalControlEvent" then
            code = msg.GetInt()
            if code >= 100 then
                k = code - 100
                if k >= 0 and k < 32 then inp.held[k] = false
                if inp.repeatKey = k then inp.repeatKey = -1
            else if code >= 0 and code < 32 then
                inp.held[code] = true
                inp.pressed.Push(code)
                inp.any = true
                if code >= 2 and code <= 5 then
                    inp.repeatKey = code
                    inp.repeatAt = NowMs() + 420
                end if
            end if
        end if
        msg = port.GetMessage()
    end while
    ' menu key repeat for the D-pad
    if inp.repeatKey >= 0 then
        if inp.held[inp.repeatKey] then
            now = NowMs()
            if now >= inp.repeatAt then
                inp.pressed.Push(inp.repeatKey + 1000)   ' >= 1000 marks a repeat
                inp.repeatAt = now + 110
            end if
        else
            inp.repeatKey = -1
        end if
    end if
    return true
end function

sub InputClearHeld()
    inp = m.inp
    for i = 0 to 31
        inp.held[i] = false
    end for
    inp.repeatKey = -1
end sub
