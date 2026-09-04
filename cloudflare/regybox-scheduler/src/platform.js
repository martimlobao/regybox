const DEFAULT_PLATFORM = "regybox";
const PLATFORM_LABELS = {
  regybox: "Regybox",
  bookr: "Bookr.fit",
};

export const REGYBOX_CALENDAR_KV_PREFIX = "regybox:v1:calendar:";
export const BOOKR_CALENDAR_KV_PREFIX = "regybox:v2:calendar:bookr:";

export function bookingPlatform(env = {}) {
  const configured = String(env.BOOKING_PLATFORM ?? "").trim();
  const platform = configured ? configured.toLowerCase() : DEFAULT_PLATFORM;
  if (!Object.hasOwn(PLATFORM_LABELS, platform)) {
    throw new Error(
      `Unsupported BOOKING_PLATFORM: ${configured}. Use "regybox" or "bookr".`,
    );
  }
  return platform;
}

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? String(platform ?? "booking platform");
}

export function calendarKvPrefix(platform) {
  return platform === "bookr" ? BOOKR_CALENDAR_KV_PREFIX : REGYBOX_CALENDAR_KV_PREFIX;
}
