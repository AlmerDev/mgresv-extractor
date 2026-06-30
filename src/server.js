import express from "express"
import cors from "cors"
import helmet from "helmet"
import { chromium } from "playwright"
import { nanoid } from "nanoid"

const app = express()
const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.EXTRACTOR_TOKEN || ""
const MAX_EXTRACT_MS = Number(process.env.MAX_EXTRACT_MS || 25000)

app.use(cors({ origin: "*" }))
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}))
app.use(express.json({ limit: "1mb" }))

let browserPromise = null

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mgresv-extractor",
    engine: "playwright chromium + platform adapters + metadata/dom/json extraction",
    supports: [
      "tiktok photo/video detection",
      "instagram post/reel detection",
      "pinterest photo detection",
      "generic metadata thumbnail",
      "dom image/video extraction"
    ]
  })
})

app.post("/extract", async (req, res) => {
  const start = Date.now()

  try {
    checkAuth(req)

    const url = normalizeUrl(req.body?.url)

    if (!url) {
      return res.status(400).json({ ok: false, error: "URL tidak valid." })
    }

    const result = await withTimeout(extract(url), MAX_EXTRACT_MS, "Extractor timeout.")

    return res.json({
      ok: true,
      requestId: nanoid(8),
      elapsedMs: Date.now() - start,
      ...result
    })
  } catch (error) {
    return res.status(422).json({
      ok: false,
      error: simplifyError(error?.message || "Extract gagal.")
    })
  }
})

async function extract(inputUrl) {
  const browser = await getBrowser()
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: browserUserAgent(),
    locale: "en-US",
    timezoneId: "UTC"
  })

  const page = await context.newPage()

  // Keep the page lighter but DO NOT block images; we need image URLs.
  await page.route("**/*", async (route) => {
    const type = route.request().resourceType()
    const url = route.request().url()

    if (["font", "stylesheet"].includes(type)) {
      return route.abort().catch(() => {})
    }

    if (/doubleclick|googletagmanager|google-analytics|analytics|adsystem|adservice/i.test(url)) {
      return route.abort().catch(() => {})
    }

    return route.continue().catch(() => {})
  })

  try {
    await page.goto(inputUrl, { waitUntil: "domcontentloaded", timeout: Math.min(MAX_EXTRACT_MS, 20000) })
    await page.waitForTimeout(3500).catch(() => {})

    const finalUrl = page.url() || inputUrl
    const platform = detectPlatform(finalUrl || inputUrl)
    const urlKind = detectKindFromUrl(finalUrl || inputUrl, platform)

    // Try clicking accept cookies / close simple dialogs without hard dependence.
    await dismissCommonDialogs(page)

    const data = await page.evaluate(() => {
      const metas = {}
      for (const meta of Array.from(document.querySelectorAll("meta"))) {
        const key = meta.getAttribute("property") || meta.getAttribute("name") || meta.getAttribute("itemprop")
        const content = meta.getAttribute("content")
        if (key && content) metas[key] = content
      }

      const scripts = Array.from(document.querySelectorAll("script"))
        .map((script) => ({
          id: script.id || "",
          type: script.type || "",
          text: script.textContent || ""
        }))
        .filter((script) => script.text && script.text.length > 10)

      const images = Array.from(document.images).map((img) => ({
        src: img.currentSrc || img.src || "",
        srcset: img.srcset || "",
        alt: img.alt || "",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        rectWidth: Math.round(img.getBoundingClientRect().width || 0),
        rectHeight: Math.round(img.getBoundingClientRect().height || 0)
      }))

      const videos = Array.from(document.querySelectorAll("video, video source, source")).map((node) => ({
        src: node.currentSrc || node.src || node.getAttribute("src") || "",
        poster: node.poster || node.getAttribute("poster") || "",
        width: node.videoWidth || node.clientWidth || 0,
        height: node.videoHeight || node.clientHeight || 0,
        type: node.getAttribute("type") || ""
      }))

      return {
        title: document.title || "",
        canonical: document.querySelector("link[rel='canonical']")?.href || "",
        metas,
        scripts,
        images,
        videos
      }
    })

    const meta = normalizeMetadata(data.metas || {})
    const jsonUrls = extractUrlsFromScripts(data.scripts || [], platform)
    const domImageUrls = extractDomImageUrls(data.images || [], platform)
    const videoUrls = extractVideoUrls(data.videos || [], meta)

    let slides = []
    let kind = urlKind || "unknown"

    if (platform === "tiktok") {
      const tiktokUrls = unique([
        ...jsonUrls,
        ...domImageUrls,
        ...(meta.image ? [meta.image] : [])
      ]).filter((item) => isValidPlatformImage(item, platform))

      if (urlKind === "photo" || tiktokUrls.length > 1) {
        kind = "photo"
        slides = toSlides(tiktokUrls, "tiktok")
      } else if (videoUrls.length || meta.video) {
        kind = "video"
      }
    } else if (platform === "instagram") {
      const instagramUrls = unique([
        ...jsonUrls,
        ...domImageUrls,
        ...(meta.image ? [meta.image] : [])
      ]).filter((item) => isValidPlatformImage(item, platform))

      if (urlKind === "photo" || instagramUrls.length) {
        kind = meta.video && urlKind !== "photo" && instagramUrls.length <= 1 ? "video" : "photo"
        if (kind === "photo") slides = toSlides(instagramUrls, "instagram")
      } else if (videoUrls.length || meta.video) {
        kind = "video"
      }
    } else if (platform === "pinterest") {
      const urls = unique([...jsonUrls, ...domImageUrls, ...(meta.image ? [meta.image] : [])])
        .filter((item) => isLikelyImageUrl(item))
      kind = "photo"
      slides = toSlides(urls, "pinterest")
    } else {
      const urls = unique([...jsonUrls, ...domImageUrls, ...(meta.image ? [meta.image] : [])])
        .filter((item) => isLikelyImageUrl(item))

      if (urlKind === "photo" || urls.length > 1) {
        kind = "photo"
        slides = toSlides(urls, platform || "media")
      } else if (videoUrls.length || meta.video || urlKind === "video") {
        kind = "video"
      } else if (urlKind === "audio") {
        kind = "audio"
      }
    }

    if (kind === "unknown") {
      if (videoUrls.length || meta.video) kind = "video"
      else if (slides.length) kind = "photo"
      else kind = "video"
    }

    const thumbnail = chooseThumbnail({
      platform,
      kind,
      metaImage: meta.image,
      slides,
      domImages: domImageUrls,
      fallback: true
    })

    const title = cleanTitle(meta.title || data.title || `${prettyPlatform(platform)} media`)

    await context.close().catch(() => {})

    return {
      platform,
      kind,
      title,
      thumbnail,
      source: finalUrl,
      originalSource: inputUrl,
      resolvedSource: finalUrl,
      slides,
      videoUrls: videoUrls.slice(0, 5),
      meta: {
        ogType: meta.type,
        hasVideo: Boolean(meta.video || videoUrls.length),
        hasImage: Boolean(meta.image || slides.length)
      }
    }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    })
  }

  return browserPromise
}

async function dismissCommonDialogs(page) {
  const labels = [
    "Accept all",
    "Accept",
    "Allow all",
    "Allow",
    "Not now",
    "Close",
    "Maybe later"
  ]

  for (const label of labels) {
    try {
      await page.getByText(label, { exact: false }).first().click({ timeout: 800 })
      await page.waitForTimeout(300)
    } catch {
      // ignore
    }
  }
}

function normalizeMetadata(metas) {
  const get = (...keys) => {
    for (const key of keys) {
      if (metas[key]) return decodeHtml(String(metas[key]))
    }
    return ""
  }

  return {
    title: get("og:title", "twitter:title", "title"),
    image: cleanMediaUrl(get("og:image", "og:image:secure_url", "twitter:image", "twitter:image:src")),
    video: cleanMediaUrl(get("og:video", "og:video:url", "og:video:secure_url", "twitter:player")),
    type: get("og:type"),
    description: get("og:description", "twitter:description", "description")
  }
}

function extractUrlsFromScripts(scripts, platform) {
  const candidates = []

  for (const script of scripts) {
    const text = normalizeEscapedText(script.text || "")

    if (script.id && ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE", "__NEXT_DATA__"].includes(script.id)) {
      try {
        const parsed = JSON.parse(decodeHtml(script.text || "").trim())
        walkJsonForUrls(parsed, candidates)
      } catch {
        // continue regex fallback
      }
    }

    // Generic JSON URL extraction
    const regexes = [
      /https:\/\/[^"'<>\\\s]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'<>\\\s]*)?/gi,
      /https:\/\/[^"'<>\\\s]+(?:image|photo|scontent|tiktokcdn|cdninstagram|fbcdn|pinimg)[^"'<>\\\s]*/gi
    ]

    for (const regex of regexes) {
      for (const match of text.matchAll(regex)) {
        if (match?.[0]) candidates.push(match[0])
      }
    }
  }

  return filterByPlatform(unique(candidates.map(cleanMediaUrl).filter(Boolean)), platform)
}

function walkJsonForUrls(node, output, key = "") {
  if (!node) return

  if (typeof node === "string") {
    const cleaned = cleanMediaUrl(node)
    if (cleaned && (isLikelyImageUrl(cleaned) || /image|photo|urlList|url_list/i.test(key))) {
      output.push(cleaned)
    }
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) walkJsonForUrls(item, output, key)
    return
  }

  if (typeof node === "object") {
    // explicit TikTok imagePost path
    if (node.imagePost?.images && Array.isArray(node.imagePost.images)) {
      for (const image of node.imagePost.images) {
        const imageUrl = image?.imageURL || image?.imageUrl || image?.image_url || {}
        const list = imageUrl.urlList || imageUrl.url_list || []
        if (Array.isArray(list)) {
          for (const item of list) walkJsonForUrls(item, output, "imagePost")
        }
      }
    }

    for (const [childKey, childValue] of Object.entries(node)) {
      walkJsonForUrls(childValue, output, childKey)
    }
  }
}

function extractDomImageUrls(images, platform) {
  const candidates = []

  for (const image of images) {
    const urls = [image.src, ...parseSrcset(image.srcset)]
      .map(cleanMediaUrl)
      .filter(Boolean)

    const sizeOk = Math.max(Number(image.width || 0), Number(image.rectWidth || 0)) >= 120 &&
      Math.max(Number(image.height || 0), Number(image.rectHeight || 0)) >= 120

    for (const url of urls) {
      if (sizeOk || isPlatformCdn(url, platform)) candidates.push(url)
    }
  }

  return filterByPlatform(unique(candidates), platform)
}

function extractVideoUrls(videos, meta) {
  const urls = []

  if (meta?.video) urls.push(meta.video)

  for (const video of videos) {
    if (video.src) urls.push(video.src)
    if (video.poster) urls.push(video.poster)
  }

  return unique(urls.map(cleanMediaUrl).filter(Boolean))
}

function filterByPlatform(urls, platform) {
  if (platform === "instagram") {
    return urls.filter((item) => {
      const value = item.toLowerCase()
      if (!/(scontent|cdninstagram|fbcdn)/.test(value)) return false
      if (/static\.cdninstagram|sprite|glyph|favicon|logo|profile|avatar|rsrc\.php/.test(value)) return false
      return true
    })
  }

  if (platform === "tiktok") {
    return urls.filter((item) => {
      const value = item.toLowerCase()
      if (!/(tiktokcdn|muscdn|byteimg)/.test(value)) return false
      if (/avatar|profile|emoji|icon|logo|tos-maliva-avt/.test(value)) return false
      return true
    })
  }

  if (platform === "pinterest") {
    return urls.filter((item) => /pinimg|pinterest/.test(item.toLowerCase()))
  }

  return urls
}

function isValidPlatformImage(url, platform) {
  if (!isLikelyImageUrl(url) && !/image|photo/i.test(url)) return false
  return filterByPlatform([url], platform).length > 0
}

function isLikelyImageUrl(url) {
  const value = String(url || "").toLowerCase()
  return /\.(jpg|jpeg|png|webp|avif)(\?|$)/.test(value) ||
    /(image|photo|scontent|tiktokcdn|cdninstagram|fbcdn|pinimg)/.test(value)
}

function isPlatformCdn(url, platform) {
  const value = String(url || "").toLowerCase()
  if (platform === "instagram") return /(scontent|cdninstagram|fbcdn)/.test(value)
  if (platform === "tiktok") return /(tiktokcdn|muscdn|byteimg)/.test(value)
  if (platform === "pinterest") return /pinimg/.test(value)
  return false
}

function toSlides(urls, platform) {
  return unique(urls)
    .filter((item) => isValidPlatformImage(item, platform))
    .slice(0, 30)
    .map((item, index) => ({
      index,
      type: "photo",
      url: item,
      thumbnail: item,
      filename: `${platform || "slide"}-${index + 1}.${guessImageExt(item)}`
    }))
}

function chooseThumbnail({ platform, kind, metaImage, slides, domImages, fallback }) {
  const candidates = [
    metaImage,
    slides?.[0]?.thumbnail,
    slides?.[0]?.url,
    ...(domImages || [])
  ].filter(Boolean)

  for (const candidate of candidates) {
    const cleaned = cleanMediaUrl(candidate)
    if (cleaned && (isLikelyImageUrl(cleaned) || isPlatformCdn(cleaned, platform))) {
      return cleaned
    }
  }

  return fallback ? `/fallbacks/${platform || "media"}-${kind || "media"}.svg` : ""
}

function parseSrcset(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
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

function guessImageExt(url) {
  const match = String(url || "").toLowerCase().match(/\.(jpg|jpeg|png|webp|avif)(\?|$)/)
  return match?.[1] || "jpg"
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
  return [...new Set(items.filter(Boolean))]
}

function normalizeUrl(value) {
  try {
    const raw = String(value || "").trim()
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
    const error = new Error("Unauthorized extractor token.")
    error.status = 401
    throw error
  }
}

function browserUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
}

function simplifyError(message) {
  const msg = String(message || "").replace(/\s+/g, " ").trim()
  if (/timeout/i.test(msg)) return "Extractor timeout. Platform terlalu lambat atau memblokir browser automation."
  if (/net::ERR/i.test(msg)) return "Extractor gagal membuka link. Coba link lain."
  return msg.slice(0, 300) || "Extract gagal."
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ])
}

process.on("SIGINT", async () => {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null)
    await browser?.close().catch(() => {})
  }
  process.exit(0)
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MgreSV extractor running on ${PORT}`)
})
