import express from "express"
import cors from "cors"
import helmet from "helmet"
import { chromium } from "playwright"
import { nanoid } from "nanoid"

const app = express()
const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.EXTRACTOR_TOKEN || ""
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")
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
    engine: "playwright chromium + strict photo adapters + proxied thumbnails + clean slides",
    supports: [
      "tiktok photo/video detection",
      "instagram post/reel detection",
      "visible DOM image extraction",
      "explicit TikTok imagePost parser",
      "proxied thumbnail/image URLs",
      "noise filtering for icons/logo/static images"
    ]
  })
})

app.get("/proxy-image", async (req, res) => {
  try {
    const target = normalizeUrl(req.query?.url)

    if (!target) {
      return res.status(400).send("Invalid image URL")
    }

    const response = await fetch(target, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,id;q=0.8",
        referer: guessReferer(target),
        "user-agent": browserUserAgent()
      },
      redirect: "follow"
    })

    if (!response.ok) {
      return res.status(response.status).send("Image fetch failed")
    }

    const contentType = response.headers.get("content-type") || "image/jpeg"
    const buffer = Buffer.from(await response.arrayBuffer())

    if (!contentType.toLowerCase().includes("image") || buffer.length < 200) {
      return res.status(422).send("Not a valid image")
    }

    res.setHeader("content-type", contentType)
    res.setHeader("cache-control", "public, max-age=3600")
    res.setHeader("access-control-allow-origin", "*")
    return res.send(buffer)
  } catch (error) {
    return res.status(422).send("Proxy image failed")
  }
})

app.post("/extract", async (req, res) => {
  const start = Date.now()

  try {
    checkAuth(req)

    const url = normalizeUrl(req.body?.url)

    if (!url) {
      return res.status(400).json({ ok: false, error: "URL tidak valid." })
    }

    const baseUrl = getPublicBase(req)
    const result = await withTimeout(extract(url, baseUrl), MAX_EXTRACT_MS, "Extractor timeout.")

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

async function extract(inputUrl, baseUrl) {
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
  const networkImages = []

  page.on("response", async (response) => {
    try {
      const url = response.url()
      const headers = response.headers()
      const type = String(headers["content-type"] || "").toLowerCase()

      if (type.includes("image") && isLikelyImageUrl(url)) {
        networkImages.push(url)
      }
    } catch {
      // ignore
    }
  })

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
    await page.waitForTimeout(4500).catch(() => {})
    await dismissCommonDialogs(page)

    const finalUrl = page.url() || inputUrl
    const platform = detectPlatform(finalUrl || inputUrl)
    const urlKind = detectKindFromUrl(finalUrl || inputUrl, platform)

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
        rectHeight: Math.round(img.getBoundingClientRect().height || 0),
        top: Math.round(img.getBoundingClientRect().top || 0),
        left: Math.round(img.getBoundingClientRect().left || 0)
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
    const explicitJsonImages = extractExplicitImagesFromScripts(data.scripts || [], platform)
    const visibleDomImages = extractVisibleDomImages(data.images || [], platform)
    const validNetworkImages = filterByPlatform(unique(networkImages.map(cleanMediaUrl).filter(Boolean)), platform)
    const videoUrls = extractVideoUrls(data.videos || [], meta)

    let kind = urlKind || "unknown"
    let rawSlides = []

    if (platform === "tiktok") {
      if (urlKind === "photo") {
        // Strict priority: real post images from JSON > visible images > network images > meta image.
        rawSlides = firstNonEmpty([
          explicitJsonImages,
          visibleDomImages,
          validNetworkImages,
          meta.image ? [meta.image] : []
        ])
        kind = "photo"
      } else if (urlKind === "video" || videoUrls.length || meta.video) {
        kind = "video"
      }
    } else if (platform === "instagram") {
      if (urlKind === "photo") {
        // Avoid regex-script noise. Use visible rendered images first, then metadata.
        rawSlides = firstNonEmpty([
          visibleDomImages,
          meta.image ? [meta.image] : [],
          explicitJsonImages
        ])
        kind = meta.video && rawSlides.length <= 1 ? "video" : "photo"
      } else if (urlKind === "video" || videoUrls.length || meta.video) {
        kind = "video"
      }
    } else if (platform === "pinterest") {
      rawSlides = firstNonEmpty([
        visibleDomImages,
        meta.image ? [meta.image] : [],
        explicitJsonImages
      ])
      kind = "photo"
    } else {
      rawSlides = firstNonEmpty([
        visibleDomImages,
        meta.image ? [meta.image] : [],
        explicitJsonImages
      ])

      if (urlKind === "photo" || rawSlides.length > 1) kind = "photo"
      else if (urlKind === "audio") kind = "audio"
      else if (urlKind === "video" || videoUrls.length || meta.video) kind = "video"
      else kind = rawSlides.length ? "photo" : "video"
    }

    const originalSlides = toSlides(rawSlides, platform)
    const proxiedSlides = proxifySlides(originalSlides, baseUrl)
    const originalThumbnail = chooseThumbnail({
      platform,
      kind,
      metaImage: meta.image,
      slides: originalSlides,
      domImages: visibleDomImages,
      fallback: false
    })

    const thumbnail = originalThumbnail
      ? proxyUrl(originalThumbnail, baseUrl)
      : `/fallbacks/${platform || "media"}-${kind || "media"}.svg`

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
      slides: proxiedSlides,
      rawDebug: {
        explicitJsonCount: explicitJsonImages.length,
        visibleDomCount: visibleDomImages.length,
        networkImageCount: validNetworkImages.length,
        originalSlideCount: originalSlides.length
      },
      meta: {
        ogType: meta.type,
        hasVideo: Boolean(meta.video || videoUrls.length),
        hasImage: Boolean(meta.image || originalSlides.length)
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
  const labels = ["Accept all", "Accept", "Allow all", "Allow", "Not now", "Close", "Maybe later"]

  for (const label of labels) {
    try {
      await page.getByText(label, { exact: false }).first().click({ timeout: 700 })
      await page.waitForTimeout(250)
    } catch {
      // ignore
    }
  }
}

function extractExplicitImagesFromScripts(scripts, platform) {
  const candidates = []

  for (const script of scripts) {
    const text = String(script.text || "")

    if (script.id && ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE", "__NEXT_DATA__"].includes(script.id)) {
      try {
        const parsed = JSON.parse(decodeHtml(text).trim())
        walkJsonForExplicitImages(parsed, candidates, platform)
      } catch {
        // ignore
      }
    }

    if (platform === "tiktok" && text.includes("imagePost")) {
      const normalized = normalizeEscapedText(text)
      const matches = normalized.matchAll(/https:\/\/[^"'<>\\\s]+(?:tiktokcdn|muscdn|byteimg)[^"'<>\\\s]+(?:\.jpg|\.jpeg|\.webp|\.png|image)[^"'<>\\\s]*/gi)
      for (const match of matches) {
        if (match?.[0]) candidates.push(match[0])
      }
    }

    if (platform === "instagram" && /display_url|thumbnail_src|carousel_media/.test(text)) {
      const normalized = normalizeEscapedText(text)
      const matches = normalized.matchAll(/https:\/\/[^"'<>\\\s]+(?:scontent|cdninstagram|fbcdn)[^"'<>\\\s]+\.(?:jpg|jpeg|webp|png)(?:\?[^"'<>\\\s]*)?/gi)
      for (const match of matches) {
        if (match?.[0]) candidates.push(match[0])
      }
    }
  }

  return filterByPlatform(unique(candidates.map(cleanMediaUrl).filter(Boolean)), platform)
}

function walkJsonForExplicitImages(node, output, platform, key = "") {
  if (!node) return

  if (typeof node === "string") {
    const cleaned = cleanMediaUrl(node)
    if (cleaned && isValidPlatformImage(cleaned, platform)) output.push(cleaned)
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) walkJsonForExplicitImages(item, output, platform, key)
    return
  }

  if (typeof node === "object") {
    if (platform === "tiktok" && node.imagePost?.images && Array.isArray(node.imagePost.images)) {
      for (const image of node.imagePost.images) {
        const imageUrl = image?.imageURL || image?.imageUrl || image?.image_url || {}
        const list = imageUrl.urlList || imageUrl.url_list || []
        if (Array.isArray(list) && list[0]) output.push(list[0])
      }
      return
    }

    if (platform === "instagram") {
      if (typeof node.display_url === "string") output.push(node.display_url)
      if (typeof node.thumbnail_src === "string") output.push(node.thumbnail_src)
      if (node.image_versions2?.candidates?.[0]?.url) output.push(node.image_versions2.candidates[0].url)
    }

    for (const [childKey, childValue] of Object.entries(node)) {
      if (/avatar|profile|icon|logo/i.test(childKey)) continue
      walkJsonForExplicitImages(childValue, output, platform, childKey)
    }
  }
}

function extractVisibleDomImages(images, platform) {
  const candidates = []

  for (const image of images) {
    const width = Math.max(Number(image.width || 0), Number(image.rectWidth || 0))
    const height = Math.max(Number(image.height || 0), Number(image.rectHeight || 0))
    const area = width * height
    const urls = [image.src, ...parseSrcset(image.srcset)]
      .map(cleanMediaUrl)
      .filter(Boolean)

    // Strict filter: keep content-sized images, not icons.
    const sizeOk = width >= 160 && height >= 160 && area >= 40000

    for (const url of urls) {
      if (!sizeOk && !isPlatformCdn(url, platform)) continue
      candidates.push(url)
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

function firstNonEmpty(groups) {
  for (const group of groups) {
    if (Array.isArray(group) && group.length) return group
  }
  return []
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

  return urls.filter((item) => !/avatar|profile|sprite|favicon|logo|icon/.test(item.toLowerCase()))
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
    .slice(0, 12)
    .map((item, index) => ({
      index,
      type: "photo",
      url: item,
      thumbnail: item,
      filename: `${platform || "slide"}-${index + 1}.${guessImageExt(item)}`
    }))
}

function proxifySlides(slides, baseUrl) {
  return slides.map((slide, index) => ({
    ...slide,
    index,
    originalUrl: slide.url,
    url: proxyUrl(slide.url, baseUrl),
    thumbnail: proxyUrl(slide.thumbnail || slide.url, baseUrl)
  }))
}

function proxyUrl(url, baseUrl) {
  const clean = cleanMediaUrl(url)
  if (!clean) return ""
  return `${baseUrl}/proxy-image?url=${encodeURIComponent(clean)}`
}

function chooseThumbnail({ platform, kind, metaImage, slides, domImages, fallback }) {
  const candidates = [
    slides?.[0]?.thumbnail,
    slides?.[0]?.url,
    metaImage,
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
  return [...new Set(items.filter(Boolean).map(String))]
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

function guessReferer(target) {
  try {
    const host = new URL(target).hostname.toLowerCase()
    if (host.includes("tiktokcdn") || host.includes("muscdn") || host.includes("byteimg")) return "https://www.tiktok.com/"
    if (host.includes("cdninstagram") || host.includes("fbcdn") || host.includes("scontent")) return "https://www.instagram.com/"
    if (host.includes("pinimg")) return "https://www.pinterest.com/"
    return "https://www.google.com/"
  } catch {
    return "https://www.google.com/"
  }
}

function getPublicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http"
  const host = req.headers["x-forwarded-host"] || req.headers.host
  return `${proto}://${host}`.replace(/\/$/, "")
}

function checkAuth(req) {
  if (!TOKEN) return

  const auth = req.headers.authorization || ""
  const xToken = req.headers["x-extractor-token"] || ""

  if (auth !== `Bearer ${TOKEN}` && xToken !== TOKEN) {
    throw new Error("Unauthorized extractor token.")
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
