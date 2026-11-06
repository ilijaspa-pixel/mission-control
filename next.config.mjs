/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disabled because StrictMode double-invokes effects in dev, which causes
  // xterm.js instances to race on the same host DOM — first instance mounts,
  // then immediately gets disposed mid-setup, then a second instance mounts
  // and inherits half-wired DOM, leaving keystroke capture broken.
  reactStrictMode: false,
  // Trust the filesystem — no image optimization needed
  images: { unoptimized: true },
};

export default nextConfig;
