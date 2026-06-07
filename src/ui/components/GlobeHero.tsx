import { useEffect, useRef, useState } from "react";

// PHILOSOPHY.md §6 "Hey Chama, where's home?" — the cinematic "from the dark,
// the world appears" first-login moment. Rendered with `cobe` (~5KB WebGL,
// procedural dot-globe, no textures to ship). cobe is POLISH, not load-
// bearing: if WebGL is unavailable or cobe throws (some locked-down Tauri /
// budget-Android webviews), we fall back to the existing static globe image,
// and the searchable country list below still does the actual selecting.
//
// cobe is lazy-imported so it stays off the onboarding hot path (same idiom
// as QRScanner/QRCode). Two cobe-specific gotchas handled here:
//   1. cobe v2 has no internal loop/onRender — we drive rotation with our own
//      requestAnimationFrame calling globe.update({ phi }).
//   2. cobe injects its own overlay/marker DOM nodes and calls .remove() on
//      them (and the canvas) in destroy(). If React owns that canvas, the
//      churn desyncs the reconciler ("removeChild: node is not a child").
//      So we give cobe an imperatively-created canvas inside a React-leaf
//      host div — React only tracks the host; cobe mutates freely inside it.

type Marker = readonly [number, number];

export function GlobeHero({
  size = 190,
  markers = [],
}: {
  size?: number;
  markers?: readonly Marker[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-init when the marker set changes (serialized for a stable dep).
  const markerKey = markers.map((m) => m.join(",")).join("|");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let globe:
      | { update: (s: Record<string, unknown>) => void; destroy: () => void }
      | null = null;
    let raf = 0;
    let cancelled = false;
    let phi = 0;
    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      2,
    );

    const canvas = document.createElement("canvas");
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.style.aspectRatio = "1";
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);

    (async () => {
      try {
        const createGlobe = (await import("cobe")).default;
        if (cancelled) return;
        globe = createGlobe(canvas, {
          devicePixelRatio: dpr,
          width: size * dpr,
          height: size * dpr,
          phi: 0,
          theta: 0.28,
          dark: 1,
          diffuse: 1.2,
          mapSamples: 14000,
          mapBrightness: 5.4,
          // Muted indigo land on near-black ocean, Bitcoin-orange hubs —
          // matches the app's dark theme + accent (T.accent #f7931a).
          baseColor: [0.27, 0.25, 0.34],
          markerColor: [0.969, 0.576, 0.102],
          glowColor: [0.06, 0.06, 0.09],
          markers: markers.map((location) => ({
            location: [location[0], location[1]] as [number, number],
            size: 0.045,
          })),
        });
        const tick = () => {
          if (cancelled || !globe) return;
          // Slow auto-rotation; the world turns on its own.
          phi += 0.0042;
          globe.update({ phi });
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      try { globe?.destroy(); } catch { /* cobe teardown is best-effort */ }
      try { canvas.remove(); } catch { /* already detached */ }
    };
  }, [size, markerKey]);

  if (failed) {
    return (
      <div
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0c1e2c",
          border: "1px solid #2a2a3e",
        }}
      >
        <img
          src="/icons/africa-globe-base.png"
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: "cover", opacity: 0.92 }}
        />
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    />
  );
}
