"use client";

// The last resort: an error thrown by the ROOT LAYOUT itself, which the
// ordinary error.tsx can't catch because it renders inside that layout. In
// this app the root layout reads the session (getCurrentUser), so a database
// that is unreachable at request time lands here.
//
// It replaces the layout entirely and therefore has to supply its own <html>
// and <body>. It also can't rely on the fonts or the Tailwind theme variables
// the layout sets up, so the styling here is deliberately inline and plain —
// a stylesheet that failed to load is one of the things that can put a user on
// this page.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f5efe3",
          color: "#17233a",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: "32rem",
            padding: "1.5rem",
            border: "1px solid #e4dac8",
            borderRadius: "0.5rem",
            background: "#fffcf5",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1.125rem" }}>The app failed to start</h1>
          <p style={{ color: "#5f6a7d", fontSize: "0.875rem", lineHeight: 1.5 }}>
            Something failed before the page could be drawn. This usually means the
            database is unreachable. Try again, and tell your administrator if it
            keeps happening.
          </p>
          {error.digest && (
            <p style={{ color: "#5f6a7d", fontSize: "0.75rem" }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: "0.5rem",
              padding: "0.5rem 1rem",
              borderRadius: "9999px",
              border: "none",
              background: "#1e3a5f",
              color: "white",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
