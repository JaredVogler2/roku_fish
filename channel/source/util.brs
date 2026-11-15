' ============================================================================
' util.brs - maths, random numbers, colours and small helpers.
' BrightScript has no atan2/min/max/clamp built in; hot loops inline these
' instead of calling them, the helpers here are for everything else.
' ============================================================================

function Pi() as float
    return 3.14159265
end function

function Atan2(y as float, x as float) as float
    if x > 0 then return Atn(y / x)
    if x < 0 then
        if y >= 0 then return Atn(y / x) + 3.14159265
        return Atn(y / x) - 3.14159265
    end if
    if y > 0 then return 1.57079633
    if y < 0 then return -1.57079633
    return 0.0
end function

function MinF(a as float, b as float) as float
    if a < b then return a
    return b
end function

function MaxF(a as float, b as float) as float
    if a > b then return a
    return b
end function

function ClampF(v as float, lo as float, hi as float) as float
    if v < lo then return lo
    if v > hi then return hi
    return v
end function

function ClampI(v as integer, lo as integer, hi as integer) as integer
    if v < lo then return lo
    if v > hi then return hi
    return v
end function

function LerpF(a as float, b as float, t as float) as float
    return a + (b - a) * t
end function

function Smoothstep(a as float, b as float, v as float) as float
    if b = a then return 0.0
    t = (v - a) / (b - a)
    if t < 0 then t = 0.0
    if t > 1 then t = 1.0
    return t * t * (3 - 2 * t)
end function

' Shortest signed angle from a to b, in (-pi, pi].
function AngleDiff(a as float, b as float) as float
    d = b - a
    while d > 3.14159265
        d = d - 6.2831853
    end while
    while d < -3.14159265
        d = d + 6.2831853
    end while
    return d
end function

' The reef wraps horizontally: every region is 72 units wide.
function WrapX(x as float) as float
    while x >= 72.0
        x = x - 72.0
    end while
    while x < 0.0
        x = x + 72.0
    end while
    return x
end function

' Shortest signed horizontal distance from a to b on the wrapped region.
function DxWrap(a as float, b as float) as float
    d = b - a
    if d > 36.0 then
        d = d - 72.0
    else if d < -36.0 then
        d = d + 72.0
    end if
    return d
end function

function Dist(ax as float, ay as float, bx as float, by as float) as float
    dx = bx - ax
    if dx > 36.0 then
        dx = dx - 72.0
    else if dx < -36.0 then
        dx = dx + 72.0
    end if
    dy = by - ay
    return Sqr(dx * dx + dy * dy)
end function

function Hypot(x as float, y as float) as float
    return Sqr(x * x + y * y)
end function

' Row 0 is the shallow row at the top; y grows upward from the seabed.
function SectorOf(x as float, y as float) as integer
    col = Int(WrapX(x) / 24.0)
    if col > 2 then col = 2
    if col < 0 then col = 0
    row = 2 - Int(y / 13.5)
    if row < 0 then row = 0
    if row > 2 then row = 2
    return row * 3 + col
end function

' ---------------------------------------------------------------- random numbers
' Park-Miller generator with Schrage's method: stays inside signed 32-bit integers, so it gives
' the same sequence on every device. Each stream is an associative array holding its seed.

function RngNew(seed as integer) as object
    s = seed MOD 2147483646
    if s < 0 then s = -s
    if s = 0 then s = 48271
    r = { s: s }
    ' discard a few values so close seeds diverge
    RngNext(r)
    RngNext(r)
    RngNext(r)
    return r
end function

function RngNext(r as object) as float
    s = r.s
    hi = s \ 127773
    lo = s MOD 127773
    s = 16807 * lo - 2836 * hi
    if s <= 0 then s = s + 2147483647
    r.s = s
    return s / 2147483648.0
end function

function RngRange(r as object, a as float, b as float) as float
    return a + (b - a) * RngNext(r)
end function

' Integer in [a, b] inclusive.
function RngInt(r as object, a as integer, b as integer) as integer
    v = a + Int(RngNext(r) * (b - a + 1))
    if v > b then v = b
    return v
end function

function RngChance(r as object, p as float) as boolean
    return RngNext(r) < p
end function

function RngPick(r as object, arr as object) as dynamic
    n = arr.Count()
    if n = 0 then return invalid
    i = Int(RngNext(r) * n)
    if i >= n then i = n - 1
    return arr[i]
end function

' Stable hash of a string to a positive integer (for seeds).
function HashStr(s as string) as integer
    h = 7
    n = Len(s)
    for i = 1 to n
        h = (h * 31 + Asc(Mid(s, i, 1))) MOD 16777213
    end for
    return h + 1
end function

' ---------------------------------------------------------------- colours
' Colours are 32-bit RGBA integers. Building them with multiplication would overflow for red
' >= 128, so the top byte is folded into the negative range.

function Rgba(r as integer, g as integer, b as integer, a as integer) as integer
    if r > 255 then r = 255
    if g > 255 then g = 255
    if b > 255 then b = 255
    if a > 255 then a = 255
    if r < 0 then r = 0
    if g < 0 then g = 0
    if b < 0 then b = 0
    if a < 0 then a = 0
    if r >= 128 then r = r - 256
    return r * 16777216 + g * 65536 + b * 256 + a
end function

' "#rrggbb" -> [r, g, b] integers.
function HexRgb(h as string) as object
    s = h
    if Left(s, 1) = "#" then s = Mid(s, 2)
    return [Val(Mid(s, 1, 2), 16), Val(Mid(s, 3, 2), 16), Val(Mid(s, 5, 2), 16)]
end function

function HexColor(h as string, a = 255 as integer) as integer
    c = HexRgb(h)
    return Rgba(c[0], c[1], c[2], a)
end function

' Replace the alpha byte of a colour.
function WithAlpha(c as integer, a as integer) as integer
    if a < 0 then a = 0
    if a > 255 then a = 255
    return (c and &hFFFFFF00) + a
end function

' ---------------------------------------------------------------- strings / misc

function FmtInt(n as integer) as string
    ' 12345 -> "12,345"
    s = n.ToStr()
    neg = false
    if n < 0 then
        neg = true
        s = Mid(s, 2)
    end if
    out = ""
    while Len(s) > 3
        out = "," + Right(s, 3) + out
        s = Left(s, Len(s) - 3)
    end while
    out = s + out
    if neg then out = "-" + out
    return out
end function

' One decimal place: 1.234 -> "1.2"
function Fmt1(v as float) as string
    n = Int(v * 10 + 0.5)
    if n < 0 then n = Int(v * 10 - 0.5)
    whole = n \ 10
    frac = n MOD 10
    if frac < 0 then frac = -frac
    sign = ""
    if v < 0 and whole = 0 then sign = "-"
    return sign + whole.ToStr() + "." + frac.ToStr()
end function

function Fmt2(v as float) as string
    n = Int(v * 100 + 0.5)
    whole = n \ 100
    frac = n MOD 100
    f = frac.ToStr()
    if frac < 10 then f = "0" + f
    return whole.ToStr() + "." + f
end function

function Pad2(n as integer) as string
    if n < 10 then return "0" + n.ToStr()
    return n.ToStr()
end function

function ArrayHas(arr as object, v as dynamic) as boolean
    for each x in arr
        if x = v then return true
    end for
    return false
end function

' Lower-case key lookup: JSON data is written with lower-case keys (see tools/export-data).
function MapGet(aa as object, key as string) as dynamic
    return aa[LCase(key)]
end function

function ReadJson(path as string) as dynamic
    txt = ReadAsciiFile(path)
    if txt = invalid or txt = "" then
        print "ReadJson: missing "; path
        return invalid
    end if
    j = ParseJson(txt)
    if j = invalid then print "ReadJson: bad JSON "; path
    return j
end function

function NowMs() as integer
    return m.clock.TotalMilliseconds()
end function
