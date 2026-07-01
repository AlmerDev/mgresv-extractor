import express from "express"
import cors from "cors"
import helmet from "helmet"
import { nanoid } from "nanoid"

const app = express()
const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.EXTRACTOR_TOKEN || ""
const MAX_FETCH_MS = Number(process.env.MAX_FETCH_MS || 12000)

app.use(cors({ origin: "*" }))
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}))
app.use(express.json({ limit: "1mb" }))

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mgresv-extractor",
    mode: "memory-lite",
    engine: "no-browser extractor + oembed + metadata + platform json + strict photo/video routing",
    supports: [
      "no chromium memory crash",
      "tiktok photo/video url detection",
      "tiktok item detail json attempt",
      "instagram post/reel routing",
      "metadata thumbnail",
      "safe fallback without fake video list"
    ]
  })
})

app.post("/extract", async (req, res) => {
  const start = Date.now()

  try {
    checkAuth(req)

    const inputUrl = normalizeUrl(req.body?.url)

    if (!inputUrl) {
      return res.status(400).json({ ok: false, error: "URL tidak valid." })
    }

    const result = await extractLite(inputUrl)

    return res.json({
      ok: true,
      requestId: nanoid(8),
      elapsedMs: Date.now() - start,
      ...result
    })
  } catch (error) {
    const inputUrl = normalizeUrl(req.body?.url) || ""
    return res.json({
      ok: true,
      requestId: nanoid(8),
      elapsedMs: Date.now() - start,
      ...fallbackResult(inputUrl, "error"),
      warning: simplifyError(error?.message || "Extract gagal.")
    })
  }
})

async function extractLite(inputUrl) {
  const resolvedUrl = await resolveFinalUrl(inputUrl)
  const platform = detectPlatform(resolvedUrl || inputUrl)
  const kind = detectKindFromUrl(resolvedUrl || inputUrl, platform) || "video"

  const [meta, oembed, platformData] = await Promise.all([
    fetchMetadata(resolvedUrl || inputUrl),
    fetchOEmbed(resolvedUrl || inputUrl, platform),
    fetchPlatformData(resolvedUrl || inputUrl, platform, kind)
  ])

  let slides = platformData.slides || []

  if (!slides.length && kind === "photo") {
    const candidates = [
      platformData.thumbnail,
      oembed.thumbnail,
      meta.thumbnail
    ].filter(Boolean)

    slides = unique(candidates)
      .filter((item) => isValidImageForPlatform(item, platform))
      .slice(0, 5)
      .map((item, index) => ({
        index,
        type: "photo",
        url: item,
        thumbnail: item,
        filename: `${platform || "photo"}-${index + 1}.${guessImageExt(item)}`
      }))
  }

  const title = cleanTitle(platformData.title || oembed.title || meta.title || defaultTitle(platform, kind))
  const thumbnail = platformData.thumbnail || oembed.thumbnail || meta.thumbnail || fallbackThumbnail(platform, kind)

  return {
    platform,
    kind,
    title,
    thumbnail,
    source: resolvedUrl || inputUrl,
    originalSource: inputUrl,
    resolvedSource: resolvedUrl || inputUrl,
    slides,
    rawDebug: {
      mode: "memory-lite",
      slideCount: slides.length,
      thumbnailSource: platformData.thumbnail ? "platform" : oembed.thumbnail ? "oembed" : meta.thumbnail ? "metadata" : "fallback"
    },
    meta: {
      ogType: meta.ogType || "",
      hasVideo: kind === "video",
      hasImage: kind === "photo"
    }
  }
}

async function fetchPlatformData(url, platform, kind) {
  if (platform === "tiktok") {
    return await fetchTikTokData(url, kind)
  }

  return {
    title: "",
    thumbnail: "",
    slides: []
  }
}

async function fetchTikTokData(url, kind) {
  const itemId = extractTikTokItemId(url)

  if (!itemId) {
    return { title: "", thumbnail: "", slides: [] }
  }

  const endpoints = [
    `https://www.tiktok.com/api/item/detail/?itemId=${encodeURIComponent(itemId)}&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=Win32&browser_version=5.0&channel=tiktok_web&cookie_enabled=true&device_platform=web_pc&focus_state=true&from_page=user&history_len=2&is_fullscreen=false&is_page_visible=true&language=en&os=windows&priority_region=&referer=&region=US&screen_height=1080&screen_width=1920&tz_name=UTC&webcast_language=en`,
    `https://www.tiktok.com/api/item/detail/?itemId=${encodeURIComponent(itemId)}`
  ]

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint, url)

      if (!data) continue

      const item = findTikTokItem(data)
      const title = item?.desc || item?.contents?.[0]?.desc || ""

      const imageUrls = extractTikTokImagePostUrls(item || data)
      const cover = firstClean([
        item?.video?.cover,
        item?.video?.originCover,
        item?.video?.dynamicCover,
        item?.imagePost?.cover?.urlList?.[0],
        imageUrls[0]
      ])

      if (imageUrls.length || cover) {
        return {
          title,
          thumbnail: cover || imageUrls[0] || "",
          slides: imageUrls.slice(0, 10).map((item, index) => ({
            index,
            type: "photo",
            url: item,
            thumbnail: item,
            filename: `tiktok-${index + 1}.${guessImageExt(item)}`
          }))
        }
      }
    } catch {
      // try next endpoint
    }
  }

  return { title: "", thumbnail: "", slides: [] }
}

function findTikTokItem(data) {
  if (!data || typeof data !== "object") return null
  if (data.itemInfo?.itemStruct) return data.itemInfo.itemStruct
  if (data.itemStruct) return data.itemStruct
  if (data.item) return data.item
  return null
}

function extractTikTokImagePostUrls(data) {
  const urls = []

  function push(value) {
    const clean = cleanMediaUrl(value)
    if (clean && isValidImageForPlatform(clean, "tiktok")) urls.push(clean)
  }

  const item = findTikTokItem(data) || data
  const images = item?.imagePost?.images

  if (Array.isArray(images)) {
    for (const image of images) {
      const imageUrl = image?.imageURL || image?.imageUrl || image?.image_url || {}
      const list = imageUrl.urlList || imageUrl.url_list || []

      if (Array.isArray(list) && list.length) {
        push(list[0])
      }

      push(imageUrl.uri)
    }
  }

  walkJsonForImages(item, urls, "tiktok")

  return unique(urls).slice(0, 10)
}

function walkJsonForImages(node, output, platform) {
  if (!node) return

  if (typeof node === "string") {
    const clean = cleanMediaUrl(node)
    if (clean && isValidImageForPlatform(clean, platform)) output.push(clean)
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) walkJsonForImages(item, output, platform)
    return
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (/avatar|profile|icon|logo|emoji/i.test(key)) continue
      if (/image|photo|cover|urlList|url_list|display/i.test(key)) {
        walkJsonForImages(value, output, platform)
      }
    }
  }
}

async function fetchMetadata(url) {
  try {
    const html = await fetchText(url)
    const normalized = normalizeEscapedText(html)

    const title = firstMeta(normalized, ["og:title", "twitter:title"]) || extractTitle(normalized)
    const thumbnail = cleanMediaUrl(firstMeta(normalized, [
      "og:image",
      "og:image:secure_url",
      "twitter:image",
      "twitter:image:src"
    ]))
    const ogType = firstMeta(normalized, ["og:type"]) || ""

    return {
      title: decodeHtml(title),
      thumbnail,
      ogType
    }
  } catch {
    return { title: "", thumbnail: "", ogType: "" }
  }
}

async function fetchOEmbed(url, platform) {
  const endpoints = []

  if (platform === "tiktok") {
    endpoints.push(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
  }

  if (!endpoints.length) return { title: "", thumbnail: "" }

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint, url)
      if (data?.thumbnail_url || data?.title) {
        return {
          title: data.title || "",
          thumbnail: cleanMediaUrl(data.thumbnail_url || "")
        }
      }
    } catch {
      // try next
    }
  }

  return { title: "", thumbnail: "" }
}

async function resolveFinalUrl(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MAX_FETCH_MS)

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: browserHeaders(url),
      signal: controller.signal
    })
    return response.url || url
  } catch {
    return url
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchText(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MAX_FETCH_MS)

  try {
    const response = await fetch(url, {
      headers: browserHeaders(url),
      redirect: "follow",
      signal: controller.signal
    })

    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url, referer) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MAX_FETCH_MS)

  try {
    const response = await fetch(url, {
      headers: {
        ...browserHeaders(referer || url),
        accept: "application/json,text/plain,*/*"
      },
      redirect: "follow",
      signal: controller.signal
    })

    if (!response.ok) throw new Error(`Fetch JSON failed: ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

function firstMeta(html, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, "i")
    ]

    for (const pattern of patterns) {
      const match = String(html || "").match(pattern)
      if (match?.[1]) return match[1]
    }
  }

  return ""
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>(.*?)<\/title>/i)
  return match?.[1] || ""
}

function detectKindFromUrl(value, platform) {
  try {
    const parsed = new URL(value)
    const path = parsed.pathname.toLowerCase()

    if (platform === "tiktok") {
      if (path.includes("/photo/")) return "photo"
      if (path.includes("/video/")) return "video"
      if (path.includes("/music/")) return "audio"
    }

    if (platform === "instagram") {
      if (path.includes("/reel/") || path.includes("/reels/")) return "video"
      if (path.includes("/p/")) return "photo"
    }

    if (platform === "pinterest") return "photo"

    if (/\.(jpg|jpeg|png|webp|avif)$/.test(path)) return "photo"
    if (/\.(mp4|webm|mov|mkv)$/.test(path)) return "video"
    if (/\.(mp3|m4a|wav|ogg|opus)$/.test(path)) return "audio"

    return null
  } catch {
    return null
  }
}

function detectPlatform(value) {
  try {
    const host = new URL(value).hostname.toLowerCase()

    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube"
    if (host.includes("tiktok.com")) return "tiktok"
    if (host.includes("instagram.com")) return "instagram"
    if (host.includes("facebook.com") || host.includes("fb.watch")) return "facebook"
    if (host.includes("twitter.com") || host.includes("x.com")) return "x"
    if (host.includes("threads.net")) return "threads"
    if (host.includes("pinterest.") || host.includes("pin.it")) return "pinterest"
    if (host.includes("soundcloud.com")) return "soundcloud"
    if (host.includes("reddit.com")) return "reddit"
    if (host.includes("vimeo.com")) return "vimeo"
    return "other"
  } catch {
    return "other"
  }
}

function isValidImageForPlatform(url, platform) {
  const value = String(url || "").toLowerCase()
  if (!value.startsWith("http")) return false

  if (platform === "tiktok") {
    if (!/(tiktokcdn|muscdn|byteimg)/.test(value)) return false
    if (/avatar|profile|emoji|icon|logo|tos-maliva-avt/.test(value)) return false
  }

  if (platform === "instagram") {
    if (!/(scontent|cdninstagram|fbcdn)/.test(value)) return false
    if (/static\.cdninstagram|sprite|glyph|favicon|logo|profile|avatar|rsrc\.php/.test(value)) return false
  }

  return /\.(jpg|jpeg|png|webp|avif)(\?|$)/.test(value) || /image|photo|tos-/.test(value)
}

function firstClean(values) {
  for (const value of values) {
    const clean = cleanMediaUrl(value)
    if (clean) return clean
  }
  return ""
}

function fallbackResult(inputUrl, reason = "fallback") {
  const platform = detectPlatform(inputUrl)
  const kind = detectKindFromUrl(inputUrl, platform) || "video"
  return {
    platform,
    kind,
    title: defaultTitle(platform, kind),
    thumbnail: fallbackThumbnail(platform, kind),
    source: inputUrl,
    originalSource: inputUrl,
    resolvedSource: inputUrl,
    slides: [],
    rawDebug: { mode: "memory-lite", fallbackReason: reason },
    meta: {
      ogType: "",
      hasVideo: kind === "video",
      hasImage: kind === "photo"
    }
  }
}

function defaultTitle(platform, kind) {
  const label = prettyPlatform(platform)
  if (kind === "photo") return `${label} photo/slide media`
  if (kind === "audio") return `${label} audio media`
  return `${label} media`
}

function prettyPlatform(value) {
  const map = {
    tiktok: "TikTok",
    instagram: "Instagram",
    youtube: "YouTube",
    facebook: "Facebook",
    pinterest: "Pinterest",
    soundcloud: "SoundCloud",
    x: "X/Twitter",
    other: "Media"
  }
  return map[value] || String(value || "Media")
}

function fallbackThumbnail(platform, kind) {
  return `/fallbacks/${platform || "media"}-${kind || "media"}.svg`
}

function guessImageExt(url) {
  const match = String(url || "").toLowerCase().match(/\.(jpg|jpeg|png|webp|avif)(\?|$)/)
  return match?.[1] || "jpg"
}

function extractTikTokItemId(value) {
  try {
    const parsed = new URL(value)
    const match = parsed.pathname.match(/\/(?:photo|video)\/(\d+)/)
    return match?.[1] || null
  } catch {
    return null
  }
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/ \| TikTok$/, "")
    .replace(/ • Instagram photos and videos$/, "")
    .trim()
    .slice(0, 140)
}

function cleanMediaUrl(value) {
  try {
    let item = String(value || "")
      .replaceAll("\\u002F", "/")
      .replaceAll("\\/", "/")
      .replaceAll("\\u0026", "&")
      .replaceAll("&amp;", "&")
      .replaceAll("\\", "")

    item = item.split('"')[0].split("'")[0].split("<")[0].split(">")[0]
    item = item.replace(/[,;\])}]+$/g, "")

    const parsed = new URL(item)
    if (!["http:", "https:"].includes(parsed.protocol)) return ""
    return parsed.toString()
  } catch {
    return ""
  }
}

function normalizeEscapedText(value) {
  return String(value || "")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&")
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map(String))]
}

function normalizeUrl(value) {
  try {
    let raw = String(value || "").trim()
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
    const parsed = new URL(raw)
    if (!["http:", "https:"].includes(parsed.protocol)) return ""
    return parsed.toString()
  } catch {
    return ""
  }
}

function checkAuth(req) {
  if (!TOKEN) return

  const auth = req.headers.authorization || ""
  const xToken = req.headers["x-extractor-token"] || ""

  if (auth !== `Bearer ${TOKEN}` && xToken !== TOKEN) {
    throw new Error("Unauthorized extractor token.")
  }
}

function browserHeaders(referer) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9,id;q=0.8",
    referer,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  }
}

function simplifyError(message) {
  const msg = String(message || "").replace(/\s+/g, " ").trim()
  if (/timeout|aborted/i.test(msg)) return "Extractor timeout."
  return msg.slice(0, 300) || "Extract gagal."
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MgreSV memory-lite extractor running on ${PORT}`)
})
