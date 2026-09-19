const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  maxBodyBytes: 9 * 1024 * 1024,
  maxImageBytes: 6 * 1024 * 1024,
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,
  maxConcurrent: 4,
  requestDeadlineMs: 90 * 1000,
  bodyTimeoutMs: 12 * 1000,
  idempotencyTtlMs: 5 * 60 * 1000
}

class AppError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
}

function resolvePort(production) {
  const platformPort = Number(process.env.PORT)
  if (Number.isFinite(platformPort) && platformPort > 0) return Math.max(1, Math.min(65535, Math.round(platformPort)))
  return numberFromEnv('FOOD_PROXY_PORT', production ? 80 : DEFAULTS.port, 1, 65535)
}

function readLocalConfig() {
  if (process.env.NODE_ENV === 'production') return {}
  const filePath = path.resolve(__dirname, '../文档/doubaoapi.txt')
  if (!fs.existsSync(filePath)) return {}
  const text = fs.readFileSync(filePath, 'utf8')
  return {
    apiKey: (text.match(/ark-[A-Za-z0-9-]+/) || [])[0],
    endpointId: (text.match(/ep-[A-Za-z0-9_-]+/) || [])[0]
  }
}

function getCredentials() {
  const local = readLocalConfig()
  return {
    apiKey: process.env.DOUBAO_API_KEY || local.apiKey,
    endpointId: process.env.DOUBAO_ENDPOINT_ID || local.endpointId
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function requestId(request) {
  const supplied = request.headers['x-request-id']
  return typeof supplied === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID()
}

function sendJson(response, status, body, id, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-request-id': id,
    ...extraHeaders
  })
  response.end(status === 204 ? '' : JSON.stringify(body))
}

function publicError(error, id) {
  const known = error instanceof AppError
  return {
    status: known ? error.status : 500,
    body: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '识别服务暂时不可用',
      retryable: known ? error.retryable : true,
      requestId: id
    }
  }
}

function extractOutputText(result) {
  if (result.output_text) return result.output_text
  return (result.output || []).flatMap(item => item.content || []).map(item => item.text || item.output_text || '').filter(Boolean).join('\n')
}

function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AppError(502, 'MODEL_OUTPUT_INVALID', '识别结果格式异常，请重试', true)
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch (_) {
    throw new AppError(502, 'MODEL_OUTPUT_INVALID', '识别结果格式异常，请重试', true)
  }
}

function round(value) { return Math.round(Number(value || 0) * 10) / 10 }
function bounded(value, min, max) { return Math.max(min, Math.min(max, round(value))) }

function normalizeModelResult(result) {
  if (!result || !Array.isArray(result.foods)) throw new AppError(502, 'MODEL_OUTPUT_INVALID', '未获得有效的食物识别结果', true)
  const items = result.foods.slice(0, 20).map((food, index) => {
    const per100 = food && food.nutrition_per_100g || {}
    const quantity = bounded(food && food.estimated_grams || 100, 1, 5000)
    const nutrition = {
      calories: bounded(per100.calories, 0, 1000),
      protein: bounded(per100.protein, 0, 100),
      carbs: bounded(per100.carbs, 0, 100),
      fat: bounded(per100.fat, 0, 100)
    }
    return {
      id: 'doubao_' + index,
      name: String(food && food.name || '未识别食物').trim().slice(0, 40) || '未识别食物',
      quantity,
      unit: 'g',
      calories: round(nutrition.calories * quantity / 100),
      protein: round(nutrition.protein * quantity / 100),
      carbs: round(nutrition.carbs * quantity / 100),
      fat: round(nutrition.fat * quantity / 100),
      nutrition_per_100g: nutrition,
      confidence: bounded(food && food.confidence, 0, 1),
      alternatives: Array.isArray(food && food.alternatives)
        ? food.alternatives.map(value => String(value).trim().slice(0, 40)).filter(Boolean).slice(0, 3)
        : []
    }
  })
  if (!items.length) throw new AppError(422, 'NO_FOOD_DETECTED', '没有识别到食物，请重新拍摄清晰完整的餐盘', false)
  return { provider: 'doubao', items, note: 'AI 已估算菜品、分量和营养。请按实际食用量确认，营养数据仅供参考。' }
}

function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

function validateImage(body, maxImageBytes) {
  if (!body || typeof body.imageBase64 !== 'string' || !body.imageBase64.length) throw new AppError(400, 'INVALID_IMAGE', '请选择有效图片后重试')
  const base64 = body.imageBase64.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AppError(400, 'INVALID_IMAGE', '图片数据无效')
  const estimatedBytes = Math.floor(base64.length * 3 / 4)
  if (estimatedBytes > maxImageBytes) throw new AppError(413, 'IMAGE_TOO_LARGE', '图片过大，请压缩到 6MB 以内')
  const buffer = Buffer.from(base64, 'base64')
  const mimeType = detectImageMime(buffer)
  if (!mimeType) throw new AppError(415, 'UNSUPPORTED_IMAGE', '仅支持 JPEG、PNG 或 WebP 图片')
  return { base64, mimeType }
}

function isAllowedCloudImageUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return host.endsWith('.tcb.qcloud.la') || host.endsWith('.tcb.qcloud.com') ||
      /\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(host)
  } catch (_) { return false }
}

async function downloadCloudImage(imageUrl, maxImageBytes, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const allowUrl = options.allowUrl || isAllowedCloudImageUrl
  let currentUrl = String(imageUrl || '')
  if (!currentUrl || currentUrl.length > 4096 || !allowUrl(currentUrl)) {
    throw new AppError(400, 'INVALID_IMAGE_URL', '图片临时地址无效')
  }
  for (let redirects = 0; redirects <= 2; redirects++) {
    let response
    try {
      response = await fetchImpl(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(12000) })
    } catch (error) {
      if (error && error.name === 'TimeoutError') throw new AppError(504, 'IMAGE_DOWNLOAD_TIMEOUT', '读取图片超时，请重试', true)
      throw new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '无法读取临时图片，请重试', true)
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片临时地址返回异常', true)
      currentUrl = new URL(location, currentUrl).toString()
      if (!allowUrl(currentUrl)) throw new AppError(400, 'INVALID_IMAGE_URL', '图片临时地址无效')
      continue
    }
    if (!response.ok) throw new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '无法读取临时图片，请重试', true)
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > maxImageBytes) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', '图片过大，请压缩到 6MB 以内')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxImageBytes) throw new AppError(413, 'IMAGE_TOO_LARGE', '图片过大，请压缩到 6MB 以内')
    const mimeType = detectImageMime(buffer)
    if (!mimeType) throw new AppError(415, 'UNSUPPORTED_IMAGE', '仅支持 JPEG、PNG 或 WebP 图片')
    return { base64: buffer.toString('base64'), mimeType }
  }
  throw new AppError(502, 'IMAGE_DOWNLOAD_FAILED', '图片临时地址重定向过多', true)
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function callDoubao(payload, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const deadline = Date.now() + (options.deadlineMs || DEFAULTS.requestDeadlineMs)
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining < 1000) break
    try {
      const upstream = await fetchImpl('https://ark.cn-beijing.volces.com/api/v3/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.apiKey}`, 'content-type': 'application/json', 'x-request-id': options.requestId || '' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(44000, remaining))
      })
      let result
      try { result = await upstream.json() } catch (_) { throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', '识别服务返回异常，请重试', true) }
      if (!upstream.ok) {
        const retryable = upstream.status === 429 || upstream.status >= 500
        if (!retryable) throw new AppError(502, 'UPSTREAM_REJECTED', '识别请求未被接受，请稍后重试', false)
        throw new AppError(upstream.status === 429 ? 503 : 502, 'UPSTREAM_UNAVAILABLE', '识别服务繁忙，请稍后重试', true)
      }
      return options.transformResult ? options.transformResult(result) : result
    } catch (error) {
      lastError = error
      const retryable = !(error instanceof AppError) || error.retryable
      if (!retryable || attempt === 2) break
      await delay(300 * attempt)
    }
  }
  if (lastError && lastError.name === 'TimeoutError') throw new AppError(504, 'UPSTREAM_TIMEOUT', '识别超时，请重试', true)
  if (lastError instanceof AppError) throw lastError
  throw new AppError(502, 'UPSTREAM_UNAVAILABLE', '无法连接识别服务，请稍后重试', true)
}

async function analyzeFood(body, options = {}) {
  const credentials = options.credentials || getCredentials()
  if (!credentials.apiKey || !credentials.endpointId) throw new AppError(503, 'SERVICE_NOT_CONFIGURED', '识别服务尚未配置')
  const maxImageBytes = options.maxImageBytes || DEFAULTS.maxImageBytes
  const image = body && body.imageUrl
    ? await downloadCloudImage(body.imageUrl, maxImageBytes, options)
    : validateImage(body, maxImageBytes)
  const prompt = [
    '独立观察并识别照片中实际可见的全部食物，不参考预设菜名。',
    '只输出 JSON，不要 Markdown。结构为：',
    '{"foods":[{"name":"中文名","estimated_grams":数字,"confidence":0到1,"alternatives":["备选名"],"nutrition_per_100g":{"calories":数字,"protein":数字,"carbs":数字,"fat":数字}}],"meal_summary":"简述"}。',
    '相同食物合并；不要虚构看不见的食物。根据可见分量和常见烹饪方式估算克重。营养值必须是该食物每100克可食部分的千卡、蛋白质克数、碳水克数和脂肪克数。'
  ].join('')
  const payload = {
    model: credentials.endpointId,
    input: [{ role: 'user', content: [
      { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.base64}` },
      { type: 'input_text', text: prompt }
    ] }],
    max_output_tokens: 1800
  }
  const modelResult = await callDoubao(payload, credentials, {
    ...options,
    transformResult: result => parseModelJson(extractOutputText(result))
  })
  return normalizeModelResult(modelResult)
}

function readJson(request, maxBodyBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks = []
    const finish = callback => value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const fail = finish(reject)
    const timer = setTimeout(() => fail(new AppError(408, 'REQUEST_TIMEOUT', '上传图片超时，请重试', true)), timeoutMs)
    request.on('data', chunk => {
      size += chunk.length
      if (size > maxBodyBytes) {
        fail(new AppError(413, 'REQUEST_TOO_LARGE', '请求过大，请压缩图片后重试'))
        request.resume()
      } else if (!settled) chunks.push(chunk)
    })
    request.on('aborted', () => fail(new AppError(400, 'REQUEST_ABORTED', '图片上传已中断', true)))
    request.on('error', fail)
    request.on('end', finish(() => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (_) {
        reject(new AppError(400, 'INVALID_JSON', '请求数据格式无效'))
      }
    }))
  })
}

function getClientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  }
  return request.socket.remoteAddress || 'unknown'
}

function hasCloudBaseIdentity(request) {
  const openid = request.headers['x-wx-openid']
  const appid = request.headers['x-wx-appid']
  return typeof openid === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(openid) &&
    typeof appid === 'string' && /^wx[A-Za-z0-9_-]{8,64}$/.test(appid)
}

function getRateLimitKey(request, trustProxy) {
  return hasCloudBaseIdentity(request) ? 'wx:' + request.headers['x-wx-openid'] : 'ip:' + getClientIp(request, trustProxy)
}

function createRateLimiter(max, windowMs) {
  const clients = new Map()
  return ip => {
    const now = Date.now()
    const current = clients.get(ip)
    if (!current || current.resetAt <= now) {
      clients.set(ip, { count: 1, resetAt: now + windowMs })
      return { allowed: true, remaining: max - 1, retryAfter: 0 }
    }
    current.count += 1
    if (clients.size > 10000) for (const [key, value] of clients) if (value.resetAt <= now) clients.delete(key)
    return { allowed: current.count <= max, remaining: Math.max(0, max - current.count), retryAfter: Math.ceil((current.resetAt - now) / 1000) }
  }
}

function serveExerciseMedia(response, pathname, id) {
  const match = pathname.match(/^\/exercise-media\/(images|videos)\/([A-Za-z0-9_-]+\.(?:jpg|gif))$/)
  if (!match) return false
  const folder = match[1]
  const extension = path.extname(match[2]).toLowerCase()
  if ((folder === 'images' && extension !== '.jpg') || (folder === 'videos' && extension !== '.gif')) return false
  const filePath = path.resolve(__dirname, '../文档/excercise-dataset/exercises-dataset', folder, match[2])
  if (!fs.existsSync(filePath)) {
    sendJson(response, 404, { code: 'MEDIA_NOT_FOUND', message: '动作素材不存在', requestId: id }, id)
    return true
  }
  response.writeHead(200, {
    'content-type': extension === '.gif' ? 'image/gif' : 'image/jpeg',
    'content-length': fs.statSync(filePath).size,
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'x-request-id': id
  })
  fs.createReadStream(filePath).pipe(response)
  return true
}

function createFoodProxyServer(options = {}) {
  const production = options.production !== undefined ? options.production : process.env.NODE_ENV === 'production'
  const authMode = options.authMode || process.env.FOOD_PROXY_AUTH_MODE ||
    ((options.requireAuth !== undefined ? options.requireAuth : production || process.env.FOOD_PROXY_REQUIRE_AUTH === 'true') ? 'token' : 'none')
  if (!['none', 'token', 'cloudbase'].includes(authMode)) throw new Error('FOOD_PROXY_AUTH_MODE must be none, token, or cloudbase')
  const config = {
    maxBodyBytes: options.maxBodyBytes || numberFromEnv('FOOD_PROXY_MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, 1024, 20 * 1024 * 1024),
    maxImageBytes: options.maxImageBytes || numberFromEnv('FOOD_PROXY_MAX_IMAGE_BYTES', DEFAULTS.maxImageBytes, 1024, 15 * 1024 * 1024),
    rateLimitMax: options.rateLimitMax || numberFromEnv('FOOD_PROXY_RATE_LIMIT', DEFAULTS.rateLimitMax, 1, 1000),
    rateLimitWindowMs: options.rateLimitWindowMs || DEFAULTS.rateLimitWindowMs,
    maxConcurrent: options.maxConcurrent || numberFromEnv('FOOD_PROXY_MAX_CONCURRENT', DEFAULTS.maxConcurrent, 1, 100),
    bodyTimeoutMs: options.bodyTimeoutMs || DEFAULTS.bodyTimeoutMs,
    authMode,
    clientToken: options.clientToken !== undefined ? options.clientToken : process.env.FOOD_PROXY_CLIENT_TOKEN,
    trustProxy: options.trustProxy !== undefined ? options.trustProxy : process.env.FOOD_PROXY_TRUST_PROXY === 'true'
  }
  if (config.authMode === 'token' && !config.clientToken) throw new Error('FOOD_PROXY_CLIENT_TOKEN is required in token auth mode')
  const limit = createRateLimiter(config.rateLimitMax, config.rateLimitWindowMs)
  const analyze = options.analyze || ((body, context) => analyzeFood(body, { requestId: context.requestId, maxImageBytes: config.maxImageBytes }))
  const cache = new Map()
  let active = 0

  const server = http.createServer(async (request, response) => {
    const id = requestId(request)
    const startedAt = Date.now()
    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true }, id)
    if (!production && request.method === 'GET' && serveExerciseMedia(response, url.pathname, id)) return
    if (request.method !== 'POST' || url.pathname !== '/food/analyze') return sendJson(response, 404, { code: 'NOT_FOUND', message: '接口不存在', requestId: id }, id)

    const rate = limit(getRateLimitKey(request, config.trustProxy))
    if (!rate.allowed) return sendJson(response, 429, { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试', retryable: true, requestId: id }, id, { 'retry-after': String(rate.retryAfter) })
    if (config.authMode === 'token' && !safeEqual(request.headers['x-food-proxy-token'], config.clientToken)) return sendJson(response, 401, { code: 'UNAUTHORIZED', message: '无权使用识别服务', retryable: false, requestId: id }, id)
    if (config.authMode === 'cloudbase' && !hasCloudBaseIdentity(request)) return sendJson(response, 401, { code: 'UNAUTHORIZED', message: '请通过微信云托管调用服务', retryable: false, requestId: id }, id)
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { code: 'UNSUPPORTED_CONTENT_TYPE', message: '仅支持 JSON 请求', retryable: false, requestId: id }, id)
    if (active >= config.maxConcurrent) return sendJson(response, 503, { code: 'SERVER_BUSY', message: '识别任务较多，请稍后重试', retryable: true, requestId: id }, id, { 'retry-after': '3' })

    active += 1
    try {
      const body = await readJson(request, config.maxBodyBytes, config.bodyTimeoutMs)
      const key = request.headers['x-idempotency-key']
      const validKey = typeof key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : ''
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 20)
      const cacheKey = validKey ? validKey + ':' + fingerprint : ''
      const now = Date.now()
      const cached = cacheKey && cache.get(cacheKey)
      let task
      if (cached && cached.expiresAt > now) task = cached.task
      else {
        task = Promise.resolve().then(() => analyze(body, { requestId: id }))
        if (cacheKey) {
          cache.set(cacheKey, { task, expiresAt: now + DEFAULTS.idempotencyTtlMs })
          task.catch(() => cache.delete(cacheKey))
          if (cache.size > 200) for (const [itemKey, item] of cache) if (item.expiresAt <= now) cache.delete(itemKey)
        }
      }
      sendJson(response, 200, await task, id)
    } catch (error) {
      const output = publicError(error, id)
      console.error(JSON.stringify({ level: 'error', requestId: id, code: output.body.code, message: error.message }))
      sendJson(response, output.status, output.body, id)
    } finally {
      active -= 1
      console.log(JSON.stringify({ level: 'info', requestId: id, status: response.statusCode, durationMs: Date.now() - startedAt }))
    }
  })
  server.headersTimeout = 15000
  server.requestTimeout = DEFAULTS.requestDeadlineMs + 15000
  server.keepAliveTimeout = 5000
  return server
}

function start() {
  const production = process.env.NODE_ENV === 'production'
  const credentials = getCredentials()
  if (!credentials.apiKey || !credentials.endpointId) throw new Error('DOUBAO_API_KEY and DOUBAO_ENDPOINT_ID are required')
  if (production && (!process.env.DOUBAO_API_KEY || !process.env.DOUBAO_ENDPOINT_ID)) throw new Error('Production must use environment credentials')
  const port = resolvePort(production)
  const host = process.env.FOOD_PROXY_HOST || DEFAULTS.host
  const server = createFoodProxyServer({ production })
  server.listen(port, host, () => console.log(`Food recognition proxy listening on http://${host}:${port}`))
  return server
}

if (require.main === module) {
  try {
    const server = start()
    const shutdown = signal => {
      console.log(`[food-proxy] ${signal}, stopping`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(1), 10000).unref()
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
  } catch (error) {
    console.error('[food-proxy] startup failed:', error.message)
    process.exitCode = 1
  }
}

module.exports = { AppError, analyzeFood, callDoubao, createFoodProxyServer, createRateLimiter, detectImageMime, downloadCloudImage, hasCloudBaseIdentity, isAllowedCloudImageUrl, normalizeModelResult, parseModelJson, resolvePort, start, validateImage }
