/** Definitions for the "social" write-record kind: a platform picker plus a single
 * username/ID/phone-number field, turned into that platform's public profile URL and written as
 * a plain URI record (same NDEF shape as the "url" kind — see `buildContent`/`recordToDraft` in
 * `writeRecords.ts`, and the kind translation in `WritePage.tsx`'s `attemptWrite`).
 *
 * A handful of platforms (WeChat, Signal, Kakao, ...) don't have a stable public URL that maps
 * from a username/ID to a profile, so they're left out rather than shipping a link that doesn't
 * actually work.
 */
export interface SocialPlatform {
  id: string;
  name: string;
  /** Turns whatever the user typed into the profile URL that gets written to the tag. */
  buildUrl: (handle: string) => string;
  /** Recognizes a URL as this platform's profile link and extracts the handle back out of it,
   * for loading an existing record back into the editor. `null` if the URL doesn't match. */
  parseUrl: (url: string) => string | null;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Most platforms are "https://<host>/<prefix><handle>" — this covers all of those in one
 * place; the few with odder shapes (WhatsApp's digits-only number, Mastodon's user@instance,
 * the raw-URL fallback) get their own definitions below instead of fighting this shape. */
function simplePlatform(
  id: string,
  name: string,
  hosts: string[],
  options: { prefix?: string; buildHost?: string } = {},
): SocialPlatform {
  const prefix = options.prefix ?? "";
  const buildHost = options.buildHost ?? hosts[0];
  return {
    id,
    name,
    buildUrl: (handle) => `https://${buildHost}/${prefix}${encodeURIComponent(handle.trim().replace(/^@/, ""))}`,
    parseUrl: (url) => {
      const host = hostnameOf(url);
      if (host == null || !hosts.includes(host)) return null;
      let path: string;
      try {
        path = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
      } catch {
        return null;
      }
      if (!path.startsWith(prefix)) return null;
      const rest = path.slice(prefix.length);
      if (!rest) return null;
      try {
        return decodeURIComponent(rest);
      } catch {
        return rest;
      }
    },
  };
}

const whatsapp: SocialPlatform = {
  id: "whatsapp",
  name: "WhatsApp",
  buildUrl: (handle) => `https://wa.me/${handle.replace(/\D/g, "")}`,
  parseUrl: (url) => {
    const host = hostnameOf(url);
    if (host !== "wa.me") return null;
    const digits = new URL(url).pathname.replace(/\D/g, "");
    return digits || null;
  },
};

const mastodon: SocialPlatform = {
  id: "mastodon",
  name: "Mastodon",
  buildUrl: (handle) => {
    const trimmed = handle.trim();
    const at = trimmed.indexOf("@");
    if (at === -1) return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    const user = trimmed.slice(0, at).replace(/^@/, "");
    const instance = trimmed.slice(at + 1);
    return `https://${instance}/@${user}`;
  },
  parseUrl: (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const match = parsed.pathname.match(/^\/@([^/]+)\/?$/);
    if (!match) return null;
    return `${match[1]}@${parsed.hostname}`;
  },
};

/** WeChat has no public username → profile URL mapping. `weixin://dl/chat?<ticket>` looks like
 * the obvious deep link to build one from, but the ticket it needs is a `v4_...`-format token
 * cryptographically signed by WeChat and bound to one specific verification session (scan/tap) —
 * not a fixed code that can be typed in or reused, so there's no way to construct a working one
 * from just a handle. The only thing that reliably works is the personal link WeChat itself
 * generates: long-press your own QR code in the app → "Copy Link" → a `u.wechat.com` URL that
 * opens straight to add-you when tapped (temporary — WeChat expires these; permanent links need
 * real-name verification). Passed straight through verbatim rather than derived from the
 * handle — if it's that pasted link, it stays a working link; if the user typed a bare WeChat ID
 * instead, this at least still writes it as plain text for the other person to read and search
 * by hand, rather than fabricating a link that will silently fail to open. */
const wechat: SocialPlatform = {
  id: "wechat",
  name: "微信 WeChat",
  buildUrl: (handle) => handle.trim(),
  parseUrl: (url) => {
    if (hostnameOf(url) === "u.wechat.com") return url;
    const match = url.match(/^weixin:\/\/dl\/chat\?(.+)$/i);
    return match ? match[1] : null;
  },
};

/** Escape hatch for any platform not in the list, or a link copied straight from a "share
 * profile" button — the handle field is just treated as the URL itself. Always tried last when
 * parsing, since it would otherwise swallow every other platform's URLs too. */
const other: SocialPlatform = {
  id: "other",
  name: "Other / paste link",
  buildUrl: (handle) => {
    const trimmed = handle.trim();
    return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  },
  parseUrl: (url) => url,
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  simplePlatform("instagram", "Instagram", ["instagram.com"]),
  simplePlatform("x", "X (Twitter)", ["x.com", "twitter.com"], { buildHost: "x.com" }),
  simplePlatform("facebook", "Facebook", ["facebook.com", "fb.com"], { buildHost: "facebook.com" }),
  simplePlatform("linkedin", "LinkedIn", ["linkedin.com"], { prefix: "in/" }),
  simplePlatform("tiktok", "TikTok", ["tiktok.com"], { prefix: "@" }),
  simplePlatform("youtube", "YouTube", ["youtube.com"], { prefix: "@" }),
  simplePlatform("snapchat", "Snapchat", ["snapchat.com"], { prefix: "add/" }),
  whatsapp,
  simplePlatform("telegram", "Telegram", ["t.me"]),
  simplePlatform("discord", "Discord (invite)", ["discord.gg"]),
  simplePlatform("reddit", "Reddit", ["reddit.com"], { prefix: "user/" }),
  simplePlatform("pinterest", "Pinterest", ["pinterest.com"]),
  simplePlatform("twitch", "Twitch", ["twitch.tv"]),
  simplePlatform("github", "GitHub", ["github.com"]),
  simplePlatform("threads", "Threads", ["threads.net"], { prefix: "@" }),
  mastodon,
  simplePlatform("weibo", "Weibo 微博", ["weibo.com"]),
  simplePlatform("bilibili", "Bilibili", ["space.bilibili.com"]),
  simplePlatform("xiaohongshu", "小红书", ["xiaohongshu.com"], { prefix: "user/profile/" }),
  simplePlatform("douyin", "抖音", ["douyin.com"], { prefix: "user/" }),
  wechat,
  simplePlatform("line", "Line", ["line.me"], { prefix: "ti/p/~" }),
  simplePlatform("vk", "VK", ["vk.com"]),
  simplePlatform("spotify", "Spotify", ["open.spotify.com"], { prefix: "user/" }),
  simplePlatform("soundcloud", "SoundCloud", ["soundcloud.com"]),
  other,
];

export const DEFAULT_SOCIAL_PLATFORM = "instagram";

export function socialPlatform(id: string): SocialPlatform {
  return SOCIAL_PLATFORMS.find((p) => p.id === id) ?? SOCIAL_PLATFORMS[0];
}

/** Tries every platform except the raw-URL fallback (which would match anything) in turn;
 * `null` if nothing recognizes the URL. */
export function matchSocialUrl(url: string): { platform: string; handle: string } | null {
  for (const platform of SOCIAL_PLATFORMS) {
    if (platform.id === "other") continue;
    const handle = platform.parseUrl(url);
    if (handle != null) return { platform: platform.id, handle };
  }
  return null;
}
