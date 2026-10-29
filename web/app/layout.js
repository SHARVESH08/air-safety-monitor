import "./globals.css";

export const metadata = {
  title: "AirSafe · Confined-Space Monitor",
  description: "Air safety monitor dashboard",
};

export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0f14" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
