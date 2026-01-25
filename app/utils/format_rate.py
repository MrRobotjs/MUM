from __future__ import annotations

from typing import Optional, Union


def format_bps_rate(value: Union[int, float, None]) -> Optional[str]:
    if value is None:
        return None
    try:
        bps_value = float(value)
    except (TypeError, ValueError):
        return None
    if bps_value <= 0:
        return None

    kbps = bps_value / 1000.0
    if kbps < 1000:
        return f"{kbps:.0f} Kbps"

    mbps = kbps / 1000.0
    if mbps < 1000:
        return f"{mbps:.1f} Mbps"

    gbps = mbps / 1000.0
    return f"{gbps:.1f} Gbps"
