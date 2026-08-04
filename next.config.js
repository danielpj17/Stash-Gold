const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  cacheOnFrontEndNav: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    // The default runtime caching includes a NetworkFirst "apis" route matching
    // everything under /api/ except /api/auth/callback. In a multi-user app that
    // is a leak: on a flaky network the SW serves one user's cached /api/budget
    // (or /api/auth/session) into another user's session on a shared device.
    // Losing offline API responses is the right trade — a stale balance is a
    // bug, a stale identity is a security bug.
    runtimeCaching: [],
    navigateFallbackDenylist: [/^\/api\//],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = withPWA(nextConfig);
