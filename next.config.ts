import type { NextConfig } from "next";

/**
 * Allow the app to be embedded inside Edge Impulse Studio as an extension
 * iframe. We set a Content-Security-Policy frame-ancestors directive (the
 * modern replacement for X-Frame-Options) and intentionally do NOT send
 * X-Frame-Options: DENY, which would block all framing.
 *
 * Scoped to the SPECIFIC Studio origin (plus 'self'). A wildcard across all
 * *.edgeimpulse.com subdomains would let any subdomain — including ones hosting
 * user content or vulnerable to subdomain takeover — frame the app and drive a
 * connect with attacker-chosen params. To embed under another known Studio
 * origin, add it explicitly here.
 */
const FRAME_ANCESTORS = ["'self'", "https://studio.edgeimpulse.com"].join(" ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${FRAME_ANCESTORS};`,
          },
        ],
      },
      {
        // Long-lived immutable caching for any locally-vendored assets.
        source: "/vendor/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
