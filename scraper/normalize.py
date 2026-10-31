"""Helpers that turn retailer spec strings into the keys used in site/data/reference.json."""
from __future__ import annotations

import re

# Model-number token -> reference CPU key. Longest tokens are tried first.
_CPU_TOKENS = {
    "290hx plus": "Core Ultra 9 290HX Plus",
    "290hx": "Core Ultra 9 290HX",
    "275hx": "Core Ultra 9 275HX",
    "270hx": "Core Ultra 7 270HX",
    "255hx": "Core Ultra 7 255HX",
    "251hx": "Core Ultra 7 251HX",
    "245hx": "Core 7 245HX",
    "14900hx": "Core i9-14900HX",
    "14650hx": "Core i7-14650HX",
    "13650hx": "Core i7-13650HX",
    "13620h": "Core i7-13620H",
    "13420h": "Core i5-13420H",
    "240h": "Core 7 240H",
    "210h": "Core 5 210H",
    "285h": "Core Ultra 9 285H",
    "255h": "Core Ultra 7 255H",
    "386h": "Core Ultra 9 386H",
    "358h": "Core Ultra X7 358H",
    "356h": "Core Ultra 7 356H",
    "288v": "Core Ultra 9 288V",
    "9955hx3d": "Ryzen 9 9955HX3D",
    "8945hx": "Ryzen 9 8945HX",
    "8940hx": "Ryzen 9 8940HX",
    "8745hx": "Ryzen 7 8745HX",
    "7445hs": "Ryzen 7 7445HS",
    "7535hs": "Ryzen 5 7535HS",
}
# Bare numbers only count when the string is clearly an AMD Ryzen part.
_RYZEN_NUMBERS = {
    "395": "Ryzen AI Max+ 395",
    "392": "Ryzen AI Max+ 392",
    "388": "Ryzen AI Max+ 388",
    "475": "Ryzen AI 9 HX 475",
    "470": "Ryzen AI 9 HX 470",
    "370": "Ryzen AI 9 HX 370",
    "365": "Ryzen AI 9 365",
    "450": "Ryzen AI 7 450",
    "350": "Ryzen AI 7 350",
    "270": "Ryzen 9 270",
    "260": "Ryzen 7 260",
    "240": "Ryzen 5 240",
    "170": "Ryzen 7 170",
}


def cpu_key(text: str | None) -> str | None:
    if not text:
        return None
    s = text.lower().replace("‑", "-")
    s = re.sub(r"\s+", " ", s)
    for token in sorted(_CPU_TOKENS, key=len, reverse=True):
        pattern = r"(?<![0-9a-z])" + re.escape(token).replace(r"\ ", r"\s*") + r"(?![0-9a-z])"
        if re.search(pattern, s):
            return _CPU_TOKENS[token]
    if "ryzen" in s or "amd" in s:
        for num, key in _RYZEN_NUMBERS.items():
            if re.search(r"(?<![0-9])" + num + r"(?![0-9])", s):
                return key
    return None


_GPU_PATTERNS = [
    (r"rtx\s*5090", "RTX 5090"),
    (r"rtx\s*5080", "RTX 5080"),
    (r"rtx\s*5070\s*ti", "RTX 5070 Ti"),
    (r"rtx\s*5070", "RTX 5070"),
    (r"rtx\s*5060", "RTX 5060"),
    (r"rtx\s*5050", "RTX 5050"),
    (r"rtx\s*4070", "RTX 4070"),
    (r"rtx\s*4060", "RTX 4060"),
    (r"rtx\s*4050", "RTX 4050"),
    (r"rtx\s*3050", "RTX 3050"),
    (r"8060s", "Radeon 8060S"),
    (r"arc\s*b390", "Arc B390"),
    (r"geforce\s*5070\s*ti", "RTX 5070 Ti"),
    (r"geforce\s*5070", "RTX 5070"),
]


def gpu_key(text: str | None, cpu: str | None = None) -> str | None:
    if text:
        s = text.lower()
        for pattern, key in _GPU_PATTERNS:
            if re.search(pattern, s):
                return key
    # Strix Halo listings often just say "AMD Radeon".
    if cpu and cpu.startswith("Ryzen AI Max"):
        return "Radeon 8060S"
    return None


def first_number(text, default=None):
    if text is None:
        return default
    m = re.search(r"-?\d+(?:\.\d+)?", str(text).replace(",", ""))
    return float(m.group(0)) if m else default


def parse_resolution(text: str | None):
    if not text:
        return None, None
    m = re.search(r"(\d{3,4})\s*[x×]\s*(\d{3,4})", text)
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def panel_type(text: str | None) -> str | None:
    if not text:
        return None
    s = text.lower()
    if "mini-led" in s or "mini led" in s:
        return "Mini-LED"
    if "oled" in s:
        return "OLED"
    if "ips" in s or "wva" in s or "uwva" in s or "lcd" in s or "led" in s:
        return "IPS"
    return None


def parse_title(title: str) -> dict:
    """Pull rough specs out of a retail listing title (used for the market scan)."""
    t = title or ""
    out: dict = {}
    out["cpu_key"] = cpu_key(t)
    out["gpu_key"] = gpu_key(t, out["cpu_key"])
    m = re.search(r"(\d{2})\s*GB\s*(?:DDR5|LPDDR5X?|RAM|Memory)", t, re.I) or re.search(r"(\d{2})GB\s+(?:DDR\d|RAM|Memory)", t, re.I)
    if m:
        out["ram_gb"] = int(m.group(1))
    m = re.search(r"(\d)\s*TB", t, re.I)
    if m:
        out["storage_gb"] = int(m.group(1)) * 1000
    else:
        m = re.search(r"(256|512)\s*GB\s*(?:SSD|Storage)", t, re.I)
        if m:
            out["storage_gb"] = int(m.group(1))
    m = re.search(r"(\d{2}(?:\.\d)?)\s*(?:\"|”|″|inch|-inch)", t)
    if m:
        out["screen_in"] = float(m.group(1))
    m = re.search(r"(\d{3})\s*Hz", t, re.I)
    if m:
        out["hz"] = int(m.group(1))
    out["oled"] = bool(re.search(r"OLED", t))
    brand = t.split(" - ")[0].strip() if " - " in t else t.split(" ")[0]
    out["brand"] = brand.replace("HyperX", "HP").strip()
    return out
