import express from "express"
import cors from "cors"
import helmet from "helmet"
import { nanoid } from "nanoid"

const app = express()
const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.EXTRACTOR_TOKEN || ""
const MAX_FETCH_MS = Number(process.env.MAX_FETCH_MS || 25000)
const PROVIDER_MODE = String(process.env.PROVIDER_MODE || "auto").toLowerCase()

const APIFY_TOKEN = process.env.APIFY_TOKEN || ""
const APIFY_TIKTOK_ACTOR = process.env.APIFY_TIKTOK_ACTOR || "clockworks/tiktok-scraper"
const APIFY_INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || "apify/instagram-api-scraper"
const APIFY_FACEBOOK_ACTOR = process.env.APIFY_FACEBOOK_ACTOR || ""
const APIFY_X_ACTOR = process.env.APIFY_X_ACTOR || "apidojo/tweet-scraper"
const APIFY_THREADS_ACTOR = process.env.APIFY_THREADS_ACTOR || "automation-lab/threads-scraper"
const APIFY_PINTEREST_ACTOR = process.env.APIFY_PINTEREST_ACTOR || "danielmilevski9/pinterest-crawler"
const APIFY_TIMEOUT_SECS = Number(process.env.APIFY_TIMEOUT_SECS || 45)

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || ""
const RAPIDAPI_TIKTOK_HOST = process.env.RAPIDAPI_TIKTOK_HOST || ""
const RAPIDAPI_TIKTOK_ENDPOINT = process.env.RAPIDAPI_TIKTOK_ENDPOINT || ""
const RAPIDAPI_INSTAGRAM_HOST = process.env.RAPIDAPI_INSTAGRAM_HOST || ""
const RAPIDAPI_INSTAGRAM_ENDPOINT = process.env.RAPIDAPI_INSTAGRAM_ENDPOINT || ""

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
    mode: "provider-api-system",
    engine: "provider API first + generic JSON normalizer + lite fallback",
    providers: {
      mode: PROVIDER_MODE,
      apifyEnabled: Boolean(APIFY_TOKEN),
      rapidapiEnabled: Boolean(RAPIDAPI_KEY),
      tiktokRapidHost: Boolean(RAPIDAPI_TIKTOK_HOST),
      instagramRapidHost: Boolean(RAPIDAPI_INSTAGRAM_HOST),
      facebookActorEnabled: Boolean(APIFY_FACEBOOK_ACTOR),
      xActorEnabled: Boolean(APIFY_X_ACTOR),
      threadsActorEnabled: Boolean(APIFY_THREADS_ACTOR),
      pinterestActorEnabled: Boolean(APIFY_PINTEREST_ACTOR)
    },
    supports: [
      "TikTok photo/video/provider extraction",
      "Instagram post/provider extraction",
      "provider JSON recursive URL parser",
      "strict photo/video routing",
      "no fake video list for known photo links"
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

    const result = await extractProviderFirst(inputUrl)

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

async function extractProviderFirst(inputUrl) {
  const resolvedUrl = await resolveFinalUrl(inputUrl)
  const platform = detectPlatform(resolvedUrl || inputUrl)
  const detectedKind = detectKindFromUrl(resolvedUrl || inputUrl, platform)
  const kind = detectedKind || (["pinterest", "x", "threads"].includes(platform) ? "mixed" : "video")

  const attempts = []

  if (PROVIDER_MODE === "auto" || PROVIDER_MODE === "rapidapi") {
    attempts.push(() => extractViaRapidApi(resolvedUrl || inputUrl, platform, kind))
  }

  if (PROVIDER_MODE === "auto" || PROVIDER_MODE === "apify") {
    attempts.push(() => extractViaApify(resolvedUrl || inputUrl, platform, kind))
  }

  if (PROVIDER_MODE === "auto" || PROVIDER_MODE === "lite") {
    attempts.push(() => extractLite(resolvedUrl || inputUrl, platform, kind))
  }

  const errors = []

  for (const attempt of attempts) {
    try {
      const data = await attempt()
      const normalized = normalizeProviderData(data, resolvedUrl || inputUrl, platform, kind)

      if (normalized.slides.length || normalized.thumbnail || normalized.videoUrls.length) {
        return normalized
      }
    } catch (error) {
      errors.push(String(error?.message || error || "provider failed").slice(0, 160))
    }
  }

  const fallback = fallbackResult(resolvedUrl || inputUrl, "no-provider-result")
  fallback.rawDebug.errors = errors
  return fallback
}

async function extractViaRapidApi(url, platform, kind) {
  if (!RAPIDAPI_KEY) return null

  let host = ""
  let endpoint = ""

  if (platform === "tiktok") {
    host = RAPIDAPI_TIKTOK_HOST
    endpoint = RAPIDAPI_TIKTOK_ENDPOINT
  } else if (platform === "instagram") {
    host = RAPIDAPI_INSTAGRAM_HOST
    endpoint = RAPIDAPI_INSTAGRAM_ENDPOINT
  }

  if (!host || !endpoint) return null

  const requestUrl = endpoint.includes("{url}")
    ? endpoint.replaceAll("{url}", encodeURIComponent(url))
    : endpoint.includes("?")
      ? `${endpoint}&url=${encodeURIComponent(url)}`
      : `${endpoint}?url=${encodeURIComponent(url)}`

  const fullUrl = requestUrl.startsWith("http") ? requestUrl : `https://${host}${requestUrl.startsWith("/") ? "" : "/"}${requestUrl}`

  const data = await fetchJson(fullUrl, {
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": host,
    accept: "application/json,text/plain,*/*"
  })

  return {
    provider: "rapidapi",
    data
  }
}

async function extractViaApify(url, platform, kind) {
  if (!APIFY_TOKEN) return null

  let actor = ""

  if (platform === "tiktok") actor = APIFY_TIKTOK_ACTOR
  if (platform === "instagram") actor = APIFY_INSTAGRAM_ACTOR
  if (platform === "facebook") actor = APIFY_FACEBOOK_ACTOR
  if (platform === "x") actor = APIFY_X_ACTOR
  if (platform === "threads") actor = APIFY_THREADS_ACTOR
  if (platform === "pinterest") actor = APIFY_PINTEREST_ACTOR

  if (!actor) return null

  const actorId = actor.replace("/", "~")

  const inputs = buildApifyInputCandidates(url, platform)

  for (const input of inputs) {
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=${APIFY_TIMEOUT_SECS}&memory=1024`

    try {
      const items = await fetchJson(endpoint, {
        "content-type": "application/json"
      }, {
        method: "POST",
        body: JSON.stringify(input),
        timeoutMs: (APIFY_TIMEOUT_SECS + 10) * 1000
      })

      if (Array.isArray(items) && items.length) {
        return {
          provider: "apify",
          input,
          data: items
        }
      }
    } catch {
      // try next input shape
    }
  }

  return null
}

function buildApifyInputCandidates(url, platform) {
  if (platform === "tiktok") {
    return [
      { postURLs: [url], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false },
      { startUrls: [{ url }], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false },
      { urls: [url], resultsLimit: 1 }
    ]
  }

  if (platform === "instagram") {
    const shortcode = extractInstagramShortcode(url)

    return [
      { directUrls: [url], resultsType: "posts", resultsLimit: 1, addParentData: false },
      { directUrls: [url], resultsLimit: 1 },
      { startUrls: [{ url }], resultsType: "posts", resultsLimit: 1, addParentData: false },
      { startUrls: [{ url }], resultsLimit: 1 },
      { urls: [url], resultsLimit: 1 },
      { url, resultsLimit: 1 },
      shortcode ? { shortcodes: [shortcode], resultsType: "posts", resultsLimit: 1 } : null
    ].filter(Boolean)
  }

  if (platform === "facebook") {
    return [
      { startUrls: [{ url }], resultsLimit: 1 },
      { startUrls: [url], resultsLimit: 1 },
      { urls: [url], resultsLimit: 1 },
      { url, resultsLimit: 1 },
      { directUrls: [url], resultsLimit: 1 }
    ]
  }

  if (platform === "x") {
    const tweetId = extractTweetId(url)
    return [
      tweetId ? { tweetIds: [tweetId], maxItems: 1 } : null,
      { startUrls: [{ url }], maxItems: 1 },
      { startUrls: [url], maxItems: 1 },
      { urls: [url], maxItems: 1 },
      { url, maxItems: 1 }
    ].filter(Boolean)
  }

  if (platform === "threads") {
    return [
      { startUrls: [{ url }], resultsLimit: 1, maxItems: 1 },
      { startUrls: [url], resultsLimit: 1, maxItems: 1 },
      { urls: [url], resultsLimit: 1, maxItems: 1 },
      { threadUrls: [url], resultsLimit: 1, maxItems: 1 },
      { directUrls: [url], resultsLimit: 1, maxItems: 1 },
      { url, resultsLimit: 1, maxItems: 1 }
    ]
  }

  if (platform === "pinterest") {
    return [
      { startUrls: [{ url }], maxItems: 1 },
      { startUrls: [url], maxItems: 1 },
      { urls: [url], maxItems: 1 },
      { url, maxItems: 1 }
    ]
  }

  return [
    { startUrls: [{ url }], resultsLimit: 1 },
    { urls: [url], resultsLimit: 1 }
  ]
}

async function extractLite(url, platform, kind) {
  const [meta, oembed, platformData] = await Promise.all([
    fetchMetadata(url),
    fetchOEmbed(url, platform),
    fetchPlatformData(url, platform, kind)
  ])

  return {
    provider: "lite",
    data: {
      title: platformData.title || oembed.title || meta.title || "",
      thumbnail: platformData.thumbnail || oembed.thumbnail || meta.thumbnail || "",
      slides: platformData.slides || [],
      videoUrls: [],
      kind,
      platform
    }
  }
}

function normalizeProviderData(providerPayload, sourceUrl, platform, knownKind) {
  const raw = providerPayload?.data ?? providerPayload ?? {}
  const instagramExplicitImages = platform === "instagram" ? extractInstagramCarouselImages(raw) : []
  const facebookExplicitImages = platform === "facebook" ? extractFacebookPostImages(raw) : []
  const socialExplicitMedia = platform === "pinterest" ? extractPinterestMedia(raw) : ["x", "threads"].includes(platform) ? extractGenericPostMedia(raw, platform) : { imageUrls: [], videoUrls: [], audioUrls: [], source: "none" }
  const socialExplicitImages = socialExplicitMedia.imageUrls || []
  const tiktokPhotoMode = platform === "tiktok" && knownKind === "photo"
  const tiktokExplicitImages = tiktokPhotoMode ? extractTikTokPhotoImages(raw) : []
  const title = pickTitle(raw) || defaultTitle(platform, knownKind)
  const allUrls = []
  const imageUrls = []
  const videoUrls = []
  const audioUrls = []

  if (!["instagram", "facebook", "x", "threads", "pinterest"].includes(platform) && !tiktokPhotoMode) walkAny(raw, (value, key) => {
    const clean = cleanMediaUrl(value)
    if (!clean) return

    allUrls.push(clean)

    if (isValidImageForPlatform(clean, platform)) imageUrls.push(clean)
    if (isLikelyVideoUrl(clean)) videoUrls.push(clean)
    if (isLikelyAudioUrl(clean)) audioUrls.push(clean)
  })

  for (const image of instagramExplicitImages) {
    imageUrls.push(image)
  }

  for (const image of facebookExplicitImages) {
    imageUrls.push(image)
  }

  for (const image of socialExplicitImages) {
    imageUrls.push(image)
  }

  for (const image of tiktokExplicitImages) {
    imageUrls.push(image)
  }

  for (const video of socialExplicitMedia.videoUrls || []) {
    videoUrls.push(video)
  }

  for (const audio of socialExplicitMedia.audioUrls || []) {
    audioUrls.push(audio)
  }

  // Also support common explicit array fields.
  if (!["instagram", "facebook", "x", "threads", "pinterest"].includes(platform) && !tiktokPhotoMode) for (const item of flattenItems(raw)) {
    for (const field of [
      "images", "imageUrls", "image_urls", "photos", "slides", "carouselMedia",
      "carousel_media", "carousel_media_edges", "edge_sidecar_to_children",
      "childPosts", "child_posts", "sidecarChildren", "sidecar_children",
      "displayResources", "display_resources", "displayUrl", "display_url",
      "thumbnailUrl", "thumbnail_url", "urlList", "url_list"
    ]) {
      const value = item?.[field]
      if (Array.isArray(value)) {
        for (const child of value) {
          walkAny(child, (url) => {
            const clean = cleanMediaUrl(url)
            if (clean && isValidImageForPlatform(clean, platform)) imageUrls.push(clean)
          })
        }
      }
    }
  }

  const rejectedImages = []
  const uniqueImages = unique(imageUrls)
    .filter((item) => {
      const ok = isValidImageForPlatform(item, platform)
      if (!ok) rejectedImages.push(item)
      return ok
    })
    .slice(0, 12)

  const uniqueVideos = unique(videoUrls)
    .filter((item) => isLikelyVideoUrl(item))
    .slice(0, 5)

  const uniqueAudios = unique(audioUrls)
    .filter((item) => isLikelyAudioUrl(item))
    .slice(0, 5)

  const slides = uniqueImages.map((item, index) => ({
    index,
    type: "photo",
    url: item,
    thumbnail: item,
    filename: `${platform || "photo"}-${index + 1}.${guessImageExt(item)}`
  }))

  const kind = uniqueVideos.length ? "video" :
    uniqueAudios.length && !slides.length ? "audio" :
      knownKind === "photo" || slides.length ? "photo" :
        "video"

  const pickedThumbnail = pickThumbnail(raw, platform)
  const thumbnail = firstClean(tiktokPhotoMode ? [
    slides[0]?.thumbnail,
    ...uniqueImages,
    isValidImageForPlatform(pickedThumbnail, platform) ? pickedThumbnail : ""
  ] : [
    isValidImageForPlatform(pickedThumbnail, platform) ? pickedThumbnail : "",
    slides[0]?.thumbnail,
    ...uniqueImages
  ]) || fallbackThumbnail(platform, kind)

  return {
    platform,
    kind,
    title,
    thumbnail,
    source: sourceUrl,
    originalSource: sourceUrl,
    resolvedSource: sourceUrl,
    slides,
    videoUrls: uniqueVideos,
    audioUrls: uniqueAudios,
    rawDebug: {
      provider: providerPayload?.provider || "unknown",
      imageCount: uniqueImages.length,
      rejectedImageCount: rejectedImages.length,
      rejectedImageSamples: rejectedImages.slice(0, 3),
      instagramExplicitCount: typeof instagramExplicitImages !== "undefined" ? instagramExplicitImages.length : 0,
      instagramSlideSource: instagramSlideSource(raw),
      facebookExplicitCount: typeof facebookExplicitImages !== "undefined" ? facebookExplicitImages.length : 0,
      facebookSlideSource: facebookSlideSource(raw),
      socialExplicitCount: typeof socialExplicitImages !== "undefined" ? socialExplicitImages.length : 0,
      socialVideoExplicitCount: socialExplicitMedia?.videoUrls?.length || 0,
      socialMediaSource: socialExplicitMedia?.source || "none",
      tiktokExplicitCount: typeof tiktokExplicitImages !== "undefined" ? tiktokExplicitImages.length : 0,
      tiktokSlideSource: tiktokSlideSource(raw),
      firstItemKeys: firstItemKeys(raw),
      firstItemMediaSummary: firstItemMediaSummary(raw),
      videoCount: uniqueVideos.length,
      audioCount: uniqueAudios.length
    },
    meta: {
      ogType: "",
      hasVideo: kind === "video",
      hasImage: kind === "photo"
    }
  }
}


function extractTikTokPhotoImages(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return []

  const itemStruct = first.itemStruct ||
    first.itemInfo?.itemStruct ||
    first.data?.itemInfo?.itemStruct ||
    first.item ||
    first.video ||
    first

  const imagePost = itemStruct?.imagePost ||
    itemStruct?.image_post ||
    first.imagePost ||
    first.image_post ||
    first.photoMode ||
    first.photo_mode ||
    null

  const orderedSources = [
    imagePost?.images,
    imagePost?.imageList,
    imagePost?.image_list,
    itemStruct?.imagePost?.images,
    itemStruct?.image_post?.images,
    first.slideshowImageUrls,
    first.slideshow_image_urls,
    first.carouselImages,
    first.carousel_images,
    first.photoUrls,
    first.photo_urls,
    first.imageUrls,
    first.image_urls,
    first.images,
    first.photos,
    first.slides
  ]

  for (const source of orderedSources) {
    const collected = collectTikTokPhotoImages(source)
    if (collected.length) return unique(collected).slice(0, 20)
  }

  return []
}

function collectTikTokPhotoImages(node, depth = 0) {
  const output = []
  if (!node || depth > 6) return output

  function push(value) {
    const clean = cleanMediaUrl(value)
    if (clean && isValidImageForPlatform(clean, "tiktok")) output.push(clean)
  }

  if (typeof node === "string") {
    push(node)
    return output
  }

  if (Array.isArray(node)) {
    for (const item of node) output.push(...collectTikTokPhotoImages(item, depth + 1))
    return output
  }

  if (typeof node !== "object") return output

  push(node.url)
  push(node.src)
  push(node.image)
  push(node.imageUrl)
  push(node.image_url)
  push(node.displayUrl)
  push(node.display_url)
  push(node.downloadUrl)
  push(node.download_url)

  const urlArrays = [
    node.urlList,
    node.url_list,
    node.urls,
    node.imageURL?.urlList,
    node.imageURL?.url_list,
    node.imageUrl?.urlList,
    node.image_url?.url_list,
    node.displayImage?.urlList,
    node.display_image?.url_list,
    node.image?.urlList,
    node.image?.url_list
  ]

  for (const arr of urlArrays) {
    if (!Array.isArray(arr)) continue
    for (const item of arr) push(item)
  }

  for (const [key, value] of Object.entries(node)) {
    // Keep this walker strict. TikTok provider payloads often contain covers,
    // author avatars, stickers, music thumbnails, and recommended/related images.
    if (/avatar|profile|author|owner|user|music|sound|audio|cover|dynamic|origin|icon|logo|emoji|sticker|effect|ad|recommend|related|suggest/i.test(key)) continue
    if (/imagepost|image_post|imageurl|image_url|imagelist|image_list|images|photo|photos|slide|slides|carousel|urlList|url_list/i.test(key)) {
      output.push(...collectTikTokPhotoImages(value, depth + 1))
    }
  }

  return output
}

function tiktokSlideSource(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return "none"
  const itemStruct = first.itemStruct || first.itemInfo?.itemStruct || first.data?.itemInfo?.itemStruct || first.item || first.video || first
  if (itemStruct?.imagePost?.images || itemStruct?.image_post?.images || first.imagePost?.images || first.image_post?.images) return "imagePost.images"
  if (first.slideshowImageUrls || first.slideshow_image_urls) return "slideshowImageUrls"
  if (first.carouselImages || first.carousel_images) return "carouselImages"
  if (first.photoUrls || first.photo_urls) return "photoUrls"
  if (first.imageUrls || first.image_urls) return "imageUrls"
  if (first.images) return "images"
  if (first.photos) return "photos"
  if (first.slides) return "slides"
  return "none"
}

function extractInstagramCarouselImages(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object") return []

  // Apify Instagram often returns the same post media in multiple fields.
  // For carousel, childPosts is the real post slide list. Do not merge it with
  // displayUrl/images, because that creates 1 + 5 + 5 = 11 duplicated items.
  const childPosts = Array.isArray(first.childPosts) ? first.childPosts :
    Array.isArray(first.child_posts) ? first.child_posts :
      Array.isArray(first.children) ? first.children :
        Array.isArray(first.sidecarChildren) ? first.sidecarChildren :
          Array.isArray(first.sidecar_children) ? first.sidecar_children :
            Array.isArray(first.carouselMedia) ? first.carouselMedia :
              Array.isArray(first.carousel_media) ? first.carousel_media : []

  if (childPosts.length > 0) {
    return unique(childPosts.map((child) => pickOneInstagramImage(child)).filter(Boolean)).slice(0, 20)
  }

  const images = Array.isArray(first.images) ? first.images :
    Array.isArray(first.imageUrls) ? first.imageUrls :
      Array.isArray(first.image_urls) ? first.image_urls :
        Array.isArray(first.photos) ? first.photos : []

  if (images.length > 0) {
    return unique(images.map((image) => pickOneInstagramImage(image)).filter(Boolean)).slice(0, 20)
  }

  const edges = first.edge_sidecar_to_children?.edges ||
    first.edgeSidecarToChildren?.edges ||
    first.carousel_media_edges

  if (Array.isArray(edges) && edges.length > 0) {
    return unique(edges.map((edge) => pickOneInstagramImage(edge?.node || edge)).filter(Boolean)).slice(0, 20)
  }

  const single = pickOneInstagramImage(first)
  return single ? [single] : []
}

function pickOneInstagramImage(node) {
  if (!node) return ""

  if (typeof node === "string") {
    const clean = cleanMediaUrl(node)
    return clean && isSafeProviderImageUrl(clean) ? clean : ""
  }

  if (Array.isArray(node)) {
    // images/displayResources are usually size variants; pick only one best candidate.
    for (let index = node.length - 1; index >= 0; index -= 1) {
      const candidate = pickOneInstagramImage(node[index])
      if (candidate) return candidate
    }
    return ""
  }

  if (typeof node !== "object") return ""

  const directCandidates = [
    node.displayUrl,
    node.display_url,
    node.imageUrl,
    node.image_url,
    node.thumbnailUrl,
    node.thumbnail_url,
    node.url,
    node.src
  ]

  for (const candidate of directCandidates) {
    const clean = cleanMediaUrl(candidate)
    if (clean && isSafeProviderImageUrl(clean)) return clean
  }

  const resourceArrays = [
    node.images,
    node.displayResources,
    node.display_resources,
    node.image_versions2?.candidates,
    node.imageVersions2?.candidates
  ]

  for (const arr of resourceArrays) {
    if (!Array.isArray(arr)) continue
    for (let index = arr.length - 1; index >= 0; index -= 1) {
      const candidate = pickOneInstagramImage(arr[index])
      if (candidate) return candidate
    }
  }

  return ""
}


function extractFacebookPostImages(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object") return []

  const orderedSources = [
    first.attachments,
    first.media,
    first.medias,
    first.photos,
    first.images,
    first.postImages,
    first.post_images,
    first.image,
    first.fullPicture,
    first.full_picture,
    first.picture,
    first.thumbnail,
    first.thumbnailUrl,
    first.thumbnail_url
  ]

  for (const source of orderedSources) {
    const collected = collectFacebookImages(source)
    if (collected.length) return unique(collected).slice(0, 12)
  }

  return []
}

function collectFacebookImages(node, depth = 0) {
  const output = []
  if (!node || depth > 8) return output

  function push(value) {
    const clean = cleanMediaUrl(value)
    if (clean && isValidImageForPlatform(clean, "facebook")) output.push(clean)
  }

  if (typeof node === "string") {
    push(node)
    return output
  }

  if (Array.isArray(node)) {
    for (const item of node) output.push(...collectFacebookImages(item, depth + 1))
    return output
  }

  if (typeof node !== "object") return output

  push(node.url)
  push(node.src)
  push(node.image)
  push(node.picture)
  push(node.fullPicture)
  push(node.full_picture)
  push(node.thumbnail)
  push(node.thumbnailUrl)
  push(node.thumbnail_url)

  if (node.media) output.push(...collectFacebookImages(node.media, depth + 1))
  if (node.image) output.push(...collectFacebookImages(node.image, depth + 1))
  if (node.photo_image) output.push(...collectFacebookImages(node.photo_image, depth + 1))
  if (node.cover_photo) output.push(...collectFacebookImages(node.cover_photo, depth + 1))
  if (node.subattachments) output.push(...collectFacebookImages(node.subattachments, depth + 1))
  if (node.child_attachments) output.push(...collectFacebookImages(node.child_attachments, depth + 1))
  if (node.data) output.push(...collectFacebookImages(node.data, depth + 1))

  for (const [key, value] of Object.entries(node)) {
    if (/avatar|profile|author|owner|user|comment|reaction|like|icon|logo|emoji/i.test(key)) continue
    if (/attachment|media|image|photo|picture|thumbnail|url|src/i.test(key)) {
      output.push(...collectFacebookImages(value, depth + 1))
    }
  }

  return output
}

function facebookSlideSource(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return "none"
  if (first.attachments) return "attachments"
  if (first.media || first.medias) return "media"
  if (first.photos) return "photos"
  if (first.images) return "images"
  if (first.postImages || first.post_images) return "postImages"
  if (first.fullPicture || first.full_picture) return "fullPicture"
  if (first.picture) return "picture"
  if (first.thumbnail || first.thumbnailUrl || first.thumbnail_url) return "thumbnail"
  return "none"
}



function extractPinterestMedia(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object") return { imageUrls: [], videoUrls: [], audioUrls: [], source: "none" }

  const sources = [
    ["videoUrl", first.videoUrl],
    ["video_url", first.video_url],
    ["video", first.video],
    ["videos", first.videos],
    ["videoList", first.videoList],
    ["video_list", first.video_list],
    ["storyPinData", first.storyPinData],
    ["story_pin_data", first.story_pin_data],
    ["carouselData", first.carouselData],
    ["carousel_data", first.carousel_data],
    ["images", first.images],
    ["image", first.image],
    ["imageUrl", first.imageUrl],
    ["image_url", first.image_url],
    ["imageLargeUrl", first.imageLargeUrl],
    ["image_large_url", first.image_large_url],
    ["media", first.media],
    ["medias", first.medias],
    ["pin", first.pin],
    ["data", first.data],
    ["root", first]
  ]

  const merged = { imageUrls: [], videoUrls: [], audioUrls: [], source: "none" }

  for (const [sourceName, sourceValue] of sources) {
    const collected = collectPinterestMedia(sourceValue, sourceName)
    if (collected.videoUrls.length || collected.imageUrls.length) {
      if (merged.source === "none") merged.source = sourceName
      merged.imageUrls.push(...collected.imageUrls)
      merged.videoUrls.push(...collected.videoUrls)
      merged.audioUrls.push(...collected.audioUrls)
    }
  }

  return {
    imageUrls: unique(merged.imageUrls).slice(0, 12),
    videoUrls: unique(merged.videoUrls).slice(0, 5),
    audioUrls: unique(merged.audioUrls).slice(0, 5),
    source: merged.source
  }
}

function collectPinterestMedia(node, key = "", depth = 0) {
  const output = { imageUrls: [], videoUrls: [], audioUrls: [] }
  if (!node || depth > 10) return output

  function merge(child) {
    output.imageUrls.push(...child.imageUrls)
    output.videoUrls.push(...child.videoUrls)
    output.audioUrls.push(...child.audioUrls)
  }

  function push(value, fieldKey = key) {
    const clean = cleanMediaUrl(value)
    if (!clean) return

    const lower = clean.toLowerCase()
    const field = String(fieldKey || "").toLowerCase()

    // Reject Pinterest page URLs. We only want CDN media URLs.
    if (/pinterest\.[^/]+\/pin\//.test(lower) || /pin\.it\//.test(lower)) return
    if (/avatar|profile|author|owner|user|icon|logo|emoji|sprite|favicon/.test(lower)) return

    if (isLikelyAudioUrl(lower)) {
      output.audioUrls.push(clean)
      return
    }

    if (isLikelyVideoUrl(lower) || (/video|videos|hls|mp4|story/.test(field) && /pinimg|\.mp4|\.m3u8/.test(lower))) {
      output.videoUrls.push(clean)
      return
    }

    if (isValidImageForPlatform(clean, "pinterest")) {
      output.imageUrls.push(clean)
    }
  }

  if (typeof node === "string") {
    push(node, key)
    return output
  }

  if (Array.isArray(node)) {
    for (const item of node) merge(collectPinterestMedia(item, key, depth + 1))
    return output
  }

  if (typeof node !== "object") return output

  for (const field of [
    "url", "src", "href", "image", "imageUrl", "image_url", "imageLargeUrl", "image_large_url",
    "thumbnail", "thumbnailUrl", "thumbnail_url", "displayUrl", "display_url", "preview", "previewUrl", "preview_url",
    "video", "videoUrl", "video_url", "videoSrc", "video_src", "mp4", "hls", "hlsUrl", "hls_url",
    "orig", "original", "originals"
  ]) {
    push(node?.[field], field)
  }

  for (const [childKey, value] of Object.entries(node)) {
    if (/avatar|profile|author|owner|user|comment|reply|reaction|like|icon|logo|emoji|tracking|promoted|ad/i.test(childKey)) continue
    if (/video|media|image|photo|picture|thumbnail|preview|gallery|carousel|story|attachment|url|src|mp4|hls|orig|original/i.test(childKey)) {
      merge(collectPinterestMedia(value, childKey, depth + 1))
    }
  }

  return output
}

function extractGenericPostMedia(raw, platform) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object") return { imageUrls: [], videoUrls: [], audioUrls: [], source: "none" }

  const sources = [
    ["videoVersions", first.videoVersions],
    ["video_versions", first.video_versions],
    ["videoUrl", first.videoUrl],
    ["video_url", first.video_url],
    ["video", first.video],
    ["videos", first.videos],
    ["media", first.media],
    ["medias", first.medias],
    ["attachments", first.attachments],
    ["carouselMedia", first.carouselMedia],
    ["carousel_media", first.carousel_media],
    ["gallery", first.gallery],
    ["galleryData", first.galleryData],
    ["gallery_data", first.gallery_data],
    ["images", first.images],
    ["image", first.image],
    ["photos", first.photos],
    ["photo", first.photo],
    ["pictures", first.pictures],
    ["picture", first.picture],
    ["displayUrl", first.displayUrl],
    ["display_url", first.display_url],
    ["thumbnail", first.thumbnail],
    ["thumbnailUrl", first.thumbnailUrl],
    ["thumbnail_url", first.thumbnail_url],
    ["preview", first.preview],
    ["url", first.url]
  ]

  const merged = { imageUrls: [], videoUrls: [], audioUrls: [], source: "none" }

  for (const [sourceName, sourceValue] of sources) {
    const collected = collectGenericMedia(sourceValue, platform, sourceName)

    if (collected.videoUrls.length || collected.imageUrls.length || collected.audioUrls.length) {
      if (merged.source === "none") merged.source = sourceName
      merged.imageUrls.push(...collected.imageUrls)
      merged.videoUrls.push(...collected.videoUrls)
      merged.audioUrls.push(...collected.audioUrls)
    }
  }

  return {
    imageUrls: unique(merged.imageUrls).slice(0, 12),
    videoUrls: unique(merged.videoUrls).slice(0, 5),
    audioUrls: unique(merged.audioUrls).slice(0, 5),
    source: merged.source
  }
}

function collectGenericMedia(node, platform, key = "", depth = 0) {
  const output = { imageUrls: [], videoUrls: [], audioUrls: [] }
  if (!node || depth > 9) return output

  function merge(child) {
    output.imageUrls.push(...child.imageUrls)
    output.videoUrls.push(...child.videoUrls)
    output.audioUrls.push(...child.audioUrls)
  }

  function push(value, fieldKey = key) {
    const clean = cleanMediaUrl(value)
    if (!clean) return

    const lowerKey = String(fieldKey || "").toLowerCase()

    if (isLikelyAudioUrl(clean)) {
      output.audioUrls.push(clean)
      return
    }

    if (isLikelyVideoUrl(clean) || isLikelyVideoField(clean, lowerKey)) {
      output.videoUrls.push(clean)
      return
    }

    if (isValidImageForPlatform(clean, platform)) {
      output.imageUrls.push(clean)
    }
  }

  if (typeof node === "string") {
    push(node, key)
    return output
  }

  if (Array.isArray(node)) {
    for (const item of node) merge(collectGenericMedia(item, platform, key, depth + 1))
    return output
  }

  if (typeof node !== "object") return output

  for (const field of [
    "url", "src", "href", "playUrl", "play_url", "downloadUrl", "download_url",
    "mediaUrl", "media_url", "videoUrl", "video_url", "videoSrc", "video_src",
    "hdUrl", "hd_url", "sdUrl", "sd_url", "dashUrl", "dash_url",
    "image", "imageUrl", "image_url", "displayUrl", "display_url",
    "thumbnail", "thumbnailUrl", "thumbnail_url", "previewUrl", "preview_url"
  ]) {
    push(node?.[field], field)
  }

  for (const [childKey, value] of Object.entries(node)) {
    if (/avatar|profile|author|owner|user|comment|reply|reaction|like|icon|logo|emoji/i.test(childKey)) continue

    if (/video|media|image|photo|picture|thumbnail|preview|gallery|attachment|url|src|play|download|dash/i.test(childKey)) {
      merge(collectGenericMedia(value, platform, childKey, depth + 1))
    }
  }

  return output
}

function isLikelyVideoField(url, key = "") {
  const value = String(url || "").toLowerCase()
  const field = String(key || "").toLowerCase()

  if (!value.startsWith("http")) return false
  if (isLikelyAudioUrl(value)) return false
  if (/\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) || /mime_type=image|image_jpeg|image_webp|image|photo/.test(value)) return false
  if (/thumbnail|thumb|cover|preview|image|photo|picture/.test(field)) return false
  if (!/video|play|download|dash|hd|sd|media/.test(field)) return false

  return /cdninstagram|fbcdn|fbsbx|scontent|twimg|video|mp4|m3u8|dash|play|download/.test(value)
}

function extractGenericPostImages(raw, platform) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object") return []

  const sources = [
    first.media,
    first.medias,
    first.images,
    first.image,
    first.photos,
    first.photo,
    first.pictures,
    first.picture,
    first.attachments,
    first.gallery,
    first.galleryData,
    first.gallery_data,
    first.preview,
    first.thumbnail,
    first.thumbnailUrl,
    first.thumbnail_url,
    first.displayUrl,
    first.display_url,
    first.url
  ]

  for (const source of sources) {
    const collected = collectGenericImages(source, platform)
    if (collected.length) return unique(collected).slice(0, 12)
  }

  return []
}

function collectGenericImages(node, platform, depth = 0) {
  const output = []
  if (!node || depth > 8) return output

  function push(value) {
    const clean = cleanMediaUrl(value)
    if (clean && isValidImageForPlatform(clean, platform)) output.push(clean)
  }

  if (typeof node === "string") {
    push(node)
    return output
  }

  if (Array.isArray(node)) {
    for (const item of node) output.push(...collectGenericImages(item, platform, depth + 1))
    return output
  }

  if (typeof node !== "object") return output

  push(node.url)
  push(node.src)
  push(node.image)
  push(node.imageUrl)
  push(node.image_url)
  push(node.mediaUrl)
  push(node.media_url)
  push(node.displayUrl)
  push(node.display_url)
  push(node.thumbnail)
  push(node.thumbnailUrl)
  push(node.thumbnail_url)
  push(node.previewUrl)
  push(node.preview_url)

  for (const [key, value] of Object.entries(node)) {
    if (/avatar|profile|author|owner|user|comment|reply|reaction|like|icon|logo|emoji/i.test(key)) continue
    if (/media|image|photo|picture|thumbnail|preview|gallery|attachment|url|src/i.test(key)) {
      output.push(...collectGenericImages(value, platform, depth + 1))
    }
  }

  return output
}

function extractTweetId(value) {
  try {
    const parsed = new URL(value)
    const match = parsed.pathname.match(/\/status(?:es)?\/(\d+)/i)
    return match?.[1] || ""
  } catch {
    return ""
  }
}


function firstItemKeys(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return []
  return Object.keys(first).slice(0, 50)
}

function firstItemMediaSummary(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return {}

  return {
    displayUrlType: typeof first.displayUrl,
    displayUrlSample: typeof first.displayUrl === "string" ? first.displayUrl.slice(0, 120) : "",
    imagesType: Array.isArray(first.images) ? "array" : typeof first.images,
    imagesLength: Array.isArray(first.images) ? first.images.length : 0,
    childPostsType: Array.isArray(first.childPosts) ? "array" : typeof first.childPosts,
    childPostsLength: Array.isArray(first.childPosts) ? first.childPosts.length : 0
  }
}

function instagramSlideSource(raw) {
  const first = flattenItems(raw)[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return "none"

  if (Array.isArray(first.childPosts) && first.childPosts.length) return "childPosts"
  if (Array.isArray(first.child_posts) && first.child_posts.length) return "child_posts"
  if (Array.isArray(first.children) && first.children.length) return "children"
  if (Array.isArray(first.sidecarChildren) && first.sidecarChildren.length) return "sidecarChildren"
  if (Array.isArray(first.carouselMedia) && first.carouselMedia.length) return "carouselMedia"
  if (Array.isArray(first.images) && first.images.length) return "images"
  if (first.displayUrl || first.display_url) return "displayUrl"
  return "none"
}


function extractInstagramShortcode(value) {
  try {
    const parsed = new URL(value)
    const match = parsed.pathname.match(/\/(?:p|reel|reels)\/([^/?#]+)/i)
    return match?.[1] || ""
  } catch {
    return ""
  }
}


function flattenItems(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.items)) return raw.items
  if (Array.isArray(raw?.data)) return raw.data
  if (Array.isArray(raw?.result)) return raw.result
  if (Array.isArray(raw?.results)) return raw.results
  return [raw]
}

function walkAny(node, onString, key = "") {
  if (!node) return

  if (typeof node === "string") {
    onString(node, key)
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) walkAny(item, onString, key)
    return
  }

  if (typeof node === "object") {
    for (const [childKey, childValue] of Object.entries(node)) {
      if (/avatar|profilePic|profile_pic|authorAvatar|userAvatar|icon|emoji|logo/i.test(childKey)) continue
      walkAny(childValue, onString, childKey)
    }
  }
}

function pickTitle(raw) {
  const items = flattenItems(raw)
  for (const item of items) {
    const value = item?.title || item?.caption || item?.desc || item?.description || item?.text || item?.shortcode
    if (typeof value === "string" && value.trim()) return cleanTitle(value)
  }
  return ""
}

function pickThumbnail(raw, platform) {
  const items = flattenItems(raw)
  for (const item of items) {
    const fields = [
      item?.thumbnail,
      item?.thumbnailUrl,
      item?.thumbnail_url,
      item?.cover,
      item?.coverUrl,
      item?.cover_url,
      item?.displayUrl,
      item?.display_url,
      item?.image,
      item?.imageUrl,
      item?.image_url
    ]

    for (const field of fields) {
      const clean = cleanMediaUrl(field)
      if (clean && isValidImageForPlatform(clean, platform)) return clean
    }
  }
  return ""
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
      const data = await fetchJson(endpoint, {
        ...browserHeaders(url),
        accept: "application/json,text/plain,*/*"
      })
      const normalized = normalizeProviderData({ provider: "tiktok-item-detail", data }, url, "tiktok", kind)
      if (normalized.slides.length || normalized.thumbnail) {
        return {
          title: normalized.title,
          thumbnail: isValidImageForPlatform(normalized.thumbnail, "tiktok") ? normalized.thumbnail : normalized.slides[0]?.thumbnail || "",
          slides: normalized.slides
        }
      }
    } catch {
      // try next
    }
  }

  return { title: "", thumbnail: "", slides: [] }
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

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint, {
        ...browserHeaders(url),
        accept: "application/json,text/plain,*/*"
      })
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
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      redirect: "follow",
      headers: browserHeaders(url)
    })
    return response.url || url
  } catch {
    return url
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: browserHeaders(url),
    redirect: "follow"
  })
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
  return await response.text()
}

async function fetchJson(url, headers = {}, options = {}) {
  const response = await fetchWithTimeout(url, {
    method: options.method || "GET",
    headers,
    redirect: "follow",
    body: options.body
  }, options.timeoutMs || MAX_FETCH_MS)

  if (!response.ok) throw new Error(`Fetch JSON failed: ${response.status}`)
  return await response.json()
}

async function fetchWithTimeout(url, options = {}, timeoutMs = MAX_FETCH_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
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
    const host = parsed.hostname.toLowerCase()

    if (platform === "tiktok") {
      if (path.includes("/photo/")) return "photo"
      if (path.includes("/video/")) return "video"
      if (path.includes("/music/")) return "audio"
    }

    if (platform === "instagram") {
      if (path.includes("/reel/") || path.includes("/reels/")) return "video"
      if (path.includes("/p/")) return "photo"
    }

    if (platform === "facebook") {
      if (host.includes("fb.watch") || path.includes("/watch") || path.includes("/videos/") || path.includes("/share/v/")) return "video"
      if (path.includes("/share/p/") || path.includes("/photo") || path.includes("/posts/") || path.includes("/permalink/") || path.includes("/story.php")) return "photo"
    }

    if (platform === "x") return null
    if (platform === "threads") return null
    if (platform === "pinterest") return null

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
    if (host.includes("soundcloud.com") || host.includes("reddit.com") || host.includes("redd.it") || host.includes("vimeo.com")) return "unsupported"
    return "other"
  } catch {
    return "other"
  }
}

function isSafeProviderImageUrl(url) {
  const value = String(url || "").toLowerCase()
  if (!value.startsWith("http")) return false

  if (/mime_type=audio|audio_mpeg|audio_mp4|\.mp3(\?|$)|\.m4a(\?|$)|\.ogg(\?|$)|\.wav(\?|$)/.test(value)) return false
  if (/mime_type=video|\.mp4(\?|$)|\.m3u8(\?|$)|\.webm(\?|$)|\.mov(\?|$)/.test(value)) return false
  if (/avatar|profile|emoji|icon|logo|sprite|glyph|favicon|rsrc\.php/.test(value)) return false

  return /\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) ||
    /scontent|cdninstagram|fbcdn|instagram|display|image|photo|media/.test(value)
}


function isValidImageForPlatform(url, platform) {
  const value = String(url || "").toLowerCase()
  if (!value.startsWith("http")) return false

  // Hard reject non-image media that some providers put inside "thumbnail" or mixed URL fields.
  if (/mime_type=audio|audio_mpeg|audio_mp4|\.mp3(\?|$)|\.m4a(\?|$)|\.ogg(\?|$)|\.wav(\?|$)/.test(value)) return false
  if (/mime_type=video|\.mp4(\?|$)|\.m3u8(\?|$)|\.webm(\?|$)|\.mov(\?|$)/.test(value)) return false
  if (/\/video\/tos\//.test(value)) return false

  if (platform === "tiktok") {
    if (!/(tiktokcdn|muscdn|byteimg)/.test(value)) return false
    if (/avatar|profile|emoji|icon|logo|tos-maliva-avt/.test(value)) return false

    // TikTok photo-mode images usually contain these markers.
    return /photomode|tplv-photomode|image|\.jpg(\?|$)|\.jpeg(\?|$)|\.png(\?|$)|\.webp(\?|$)|\.avif(\?|$)/.test(value)
  }

  if (platform === "instagram") {
    if (/static\.cdninstagram|sprite|glyph|favicon|logo|profile|avatar|rsrc\.php/.test(value)) return false
    if (/mime_type=audio|audio_mpeg|audio_mp4|mime_type=video|\.mp4(\?|$)|\.m3u8(\?|$)|\.mp3(\?|$)|\.m4a(\?|$)/.test(value)) return false

    return /(scontent|cdninstagram|fbcdn|instagram)/.test(value) ||
      /\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) ||
      /image|photo|display|media/.test(value)
  }

  if (platform === "facebook") {
    if (/profile|avatar|emoji|icon|logo|sprite|rsrc\.php|static/.test(value)) return false
    if (/mime_type=audio|audio_mpeg|audio_mp4|mime_type=video|\.mp4(\?|$)|\.m3u8(\?|$)|\.mp3(\?|$)|\.m4a(\?|$)/.test(value)) return false

    return /(fbcdn|scontent|facebook|fbsbx)/.test(value) ||
      /\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) ||
      /image|photo|picture|media/.test(value)
  }

  if (platform === "pinterest") {
    if (/pinterest\.[^/]+\/pin\//.test(value) || /pin\.it\//.test(value)) return false
    if (/avatar|profile|emoji|icon|logo|sprite|favicon/.test(value)) return false
    if (/video|videos|mime_type=video|\.mp4(\?|$)|\.m3u8(\?|$)/.test(value)) return false

    return /pinimg/.test(value) ||
      /\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) ||
      /image|photo|picture|media/.test(value)
  }

  return /\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/.test(value) ||
    /image|photo|pbs\.twimg|twimg/.test(value) ||
    (/(cdninstagram|fbcdn|scontent)/.test(value) && !/video|\.mp4|mime_type=video/.test(value))
}

function isLikelyVideoUrl(url) {
  const value = String(url || "").toLowerCase()
  if (/mime_type=audio|audio_mpeg|audio_mp4|\.mp3(\?|$)|\.m4a(\?|$)|\.ogg(\?|$)|\.wav(\?|$)|\.opus(\?|$)/.test(value)) return false
  if (/avatar|profile|emoji|icon|logo|sprite|glyph|favicon/.test(value)) return false
  return /\.(mp4|webm|mov|m3u8)(\?|$)/.test(value) ||
    /mime_type=video|video_mp4|playaddr|downloadaddr|video_versions|video_url|dash_url|\/video\//.test(value) ||
    (/(cdninstagram|fbcdn|fbsbx|scontent|twimg)/.test(value) && /video|\.mp4|\/v\//.test(value))
}

function isLikelyAudioUrl(url) {
  const value = String(url || "").toLowerCase()
  return /mime_type=audio|audio_mpeg|audio_mp4|soundcloud|\.(mp3|m4a|wav|ogg|opus)(\?|$)/.test(value)
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
  const detectedKind = detectKindFromUrl(inputUrl, platform)
  const kind = detectedKind || (platform === "pinterest" ? "photo" : ["x", "threads"].includes(platform) ? "mixed" : "video")
  return {
    platform,
    kind,
    title: defaultTitle(platform, kind),
    thumbnail: fallbackThumbnail(platform, kind),
    source: inputUrl,
    originalSource: inputUrl,
    resolvedSource: inputUrl,
    slides: [],
    videoUrls: [],
    audioUrls: [],
    rawDebug: { mode: "provider-api-system", fallbackReason: reason },
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
    threads: "Threads",
    x: "X/Twitter",
    unsupported: "Unsupported",
    other: "Media"
  }
  return map[value] || String(value || "Media")
}

function fallbackThumbnail(platform, kind) {
  return `/fallbacks/${platform || "media"}-${kind || "media"}.svg`
}

function guessImageExt(url) {
  const match = String(url || "").toLowerCase().match(/\.(jpg|jpeg|png|webp|avif|heic)(\?|$)/)
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
  if (/timeout|aborted/i.test(msg)) return "Provider extractor timeout."
  return msg.slice(0, 300) || "Extract gagal."
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MgreSV provider extractor running on ${PORT}`)
})
