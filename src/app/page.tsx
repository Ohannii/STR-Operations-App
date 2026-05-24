export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "0.5rem",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
        padding: "1rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>
        STR Operations App
      </h1>
      <p style={{ color: "#555", margin: 0 }}>v1.0 skeleton</p>
      <p style={{ color: "#555", margin: 0 }}>Local build running</p>
    </main>
  );
}
