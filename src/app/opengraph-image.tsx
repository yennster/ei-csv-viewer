import { ImageResponse } from "next/og";

// Open Graph / social share image for the Edge Impulse CSV Editor.
export const runtime = "edge";
export const alt = "Edge Impulse CSV Editor — every channel on its own scale";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Three lane sparklines (blue / red / green) sharing one dashed cursor, in a
// 760x150 band — the same product glyph used on the landing page.
const LANE_A =
  "M20 26 L80 14 L140 34 L200 10 L260 28 L330 18 L400 30 L470 16 L540 34 L600 12 L680 28 L740 20";
const LANE_B =
  "M20 76 L80 64 L140 84 L200 70 L260 88 L330 66 L400 80 L470 72 L540 86 L600 64 L680 82 L740 70";
const LANE_C =
  "M20 126 L80 134 L140 116 L200 138 L260 120 L330 140 L400 122 L470 130 L540 116 L600 138 L680 124 L740 132";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#f8fafc",
          padding: "70px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 15,
              backgroundColor: "#2563eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="34" height="34" viewBox="0 0 32 32" fill="none">
              <path
                d="M5 16 L12 16 L15 9 L19 23 L22 16 L27 16"
                stroke="#ffffff"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div style={{ marginLeft: 18, fontSize: 30, fontWeight: 600, color: "#334155" }}>
            Edge Impulse CSV Editor
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 70,
              fontWeight: 700,
              color: "#0f172a",
              letterSpacing: "-2px",
              lineHeight: 1.05,
            }}
          >
            Every channel on its own scale
          </div>
          <div style={{ marginTop: 22, fontSize: 30, color: "#64748b", maxWidth: 900 }}>
            Per-lane auto-scaled time-series on a shared timeline, with a
            synchronized cursor.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <svg width="760" height="150" viewBox="0 0 760 150" fill="none">
            <line x1="0" y1="50" x2="760" y2="50" stroke="#e2e8f0" strokeWidth="1.5" />
            <line x1="0" y1="100" x2="760" y2="100" stroke="#e2e8f0" strokeWidth="1.5" />
            <line
              x1="470"
              y1="0"
              x2="470"
              y2="150"
              stroke="#94a3b8"
              strokeWidth="1.5"
              strokeDasharray="5 6"
            />
            <path d={LANE_A} stroke="#3b82f6" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d={LANE_B} stroke="#ef4444" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d={LANE_C} stroke="#22c55e" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="470" cy="16" r="4" fill="#3b82f6" />
            <circle cx="470" cy="72" r="4" fill="#ef4444" />
            <circle cx="470" cy="130" r="4" fill="#22c55e" />
          </svg>
          <div style={{ display: "flex", fontSize: 24, color: "#94a3b8" }}>
            csv.jennyspeelman.dev
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
