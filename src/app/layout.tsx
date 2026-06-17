import type { Metadata } from "next";
// uPlot ships required positioning CSS (.u-wrap/.u-over/.u-under absolute
// positioning, axis/cursor layout). Without it every lane chart's canvas,
// cursor overlay, and y-gutter are mispositioned, breaking the synchronized
// crosshair and pixel alignment. Import it once, globally.
import "uplot/dist/uPlot.min.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://csv.jennyspeelman.dev"),
  title: "Edge Impulse CSV Editor",
  description:
    "Edit sensor CSV data with independent per-lane y-axes and a synchronized cursor. Standalone or embedded in Edge Impulse Studio.",
  openGraph: {
    type: "website",
    url: "https://csv.jennyspeelman.dev",
    siteName: "Edge Impulse CSV Editor",
    title: "Edge Impulse CSV Editor",
    description:
      "Per-lane auto-scaled time-series on a shared timeline, with a synchronized cursor. Standalone or embedded in Edge Impulse Studio.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Edge Impulse CSV Editor",
    description:
      "Per-lane auto-scaled time-series on a shared timeline, with a synchronized cursor.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
