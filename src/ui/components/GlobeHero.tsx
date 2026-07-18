// PHILOSOPHY.md §6 "Hey Chama, where's home?" onboarding hero.
//
// This used to run a cobe WebGL globe on an unbounded requestAnimationFrame
// loop. The country picker is often opened in several browser profiles during
// remote-bridge testing; one such profile was observed making Chrome's renderer
// unresponsive with no application exception. Motion here is decorative, so
// keep onboarding cheap and deterministic instead of spending GPU/CPU for the
// entire time a visitor considers their country.

type Marker = readonly [number, number];

export function GlobeHero({
  size = 190,
}: {
  size?: number;
  /** Retained for call-site compatibility; the static asset has baked-in dots. */
  markers?: readonly Marker[];
}) {
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
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          opacity: 0.92,
          userSelect: "none",
        }}
      />
    </div>
  );
}
