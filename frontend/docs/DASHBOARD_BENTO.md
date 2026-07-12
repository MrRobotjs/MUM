# Bento Architecture for MUM Dashboard

This document outlines the layout, component design system, and API mapping implemented during the dashboard refactor. Legacy components with overlapping layouts (`SecondaryTiles.tsx`) have been deprecated or completely refactored into modular tiles.

## Design System Principles

- **Rigid Layout:** 12-column grid layout across dynamic scales (Desktop `12`, Tablet `6`, Mobile `1` column grid stack).
- **Solid Surfaces:** No blurry effects, gradients, or heavy drop shadows. High-contrast layout utilizing `border-border` boundaries and solid `bg-card` structures.
- **Tabular Numerals:** All metric representations utilize `tabular-nums` for pixel-perfect vertical alignment during data refreshes.

## Grid Blueprint (lg Viewport)

```text
┌─────────────────────────────────────────────────────────────┐
│                       [ KPI Strip × 4 ]                     │
├──────────────────────────────┬──────────────┬───────────────┤
│                              │              │               │
│    Live Streams (7 × 2)      │  Plugin (5)  │  Users (5)    │
│    SocketIO real-time        │  Status      │  Invites      │
│                              │              │               │
├──────────────────────────────┴──────────────┴───────────────┤
│   Streaming Overview (6)     │       Stream Log (6)         │
│   Historical + Live hybrid   │       Recent activity        │
├──────────────────────────────┴──────────────────────────────┤
│                 Watch Statistics (12)                       │
└─────────────────────────────────────────────────────────────┘

```

## API Mapping & Core Dependencies

| Component | Target Endpoint / Source | Data Type | Notes |
| --- | --- | --- | --- |
| `KpiStrip` | Mixed Hooks | Aggregated Live / Hist | Drives top metric layouts |
| `LiveStreamsWidget` | SocketIO `SessionUpdate` | Real-time | Uses master socket wrapper |
| `StreamingOverviewWidget` | `/api/v2/streams/summary` & `/api/v2/streaming/active` | Hybrid Snapshot | Tracks live transcoding ratios + long-term share |
| `HistoryWidget` | `/api/v2/streams?order_by=desc(started_at)` | Stream Log | **Migration note:** Swapped out from system audit logs to active playback history. Contains dynamic `Live` badges. |
| `WatchStatsWidget` | `/api/v2/streams/summary` | Historical metrics | Clean modular rendering without nested sub-cards |

## Granular States & Defensive Handling

* **Zero-Data State:** Built-in fallback parameters prevent divide-by-zero crashes when dealing with newly-deployed infrastructure (e.g., `safeBarMax`).
* **Loading Layouts:** Integrated skeletal tracking framework (`animate-pulse`) maps onto active components instead of throwing raw global spinner animations.
