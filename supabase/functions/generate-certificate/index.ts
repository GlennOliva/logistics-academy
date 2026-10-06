import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'
import QRCode from 'npm:qrcode@1.5.4'
import { createClient } from 'npm:@supabase/supabase-js@2'

// The supplied template prints "all 8 modules" as static artwork, so refuse to
// stamp a certificate for a curriculum of a different length.
const TEMPLATE_MODULE_COUNT = 9

// Colours sampled from the supplied template's own content stream.
const NAVY = rgb(30 / 255, 58 / 255, 95 / 255)
const CREAM = rgb(255 / 255, 248 / 255, 238 / 255)

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

type Measurable = { widthOfTextAtSize(text: string, size: number): number }

function fittedSize(font: Measurable, text: string, maximum: number, start: number, floor: number) {
  let size = start
  while (size > floor && font.widthOfTextAtSize(text, size) > maximum) size -= 1
  return size
}

function centredX(font: Measurable, text: string, size: number, centre: number) {
  return centre - font.widthOfTextAtSize(text, size) / 2
}

// Draws a QR code as vector modules so it stays crisp at print resolution.
function drawQr(
  page: ReturnType<PDFDocument['addPage']>,
  payload: string,
  origin: { x: number; y: number; size: number },
) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' })
  const modules = qr.modules
  const quiet = 2
  const cell = origin.size / (modules.size + quiet * 2)
  page.drawRectangle({
    x: origin.x - 3,
    y: origin.y - 3,
    width: origin.size + 6,
    height: origin.size + 6,
    color: CREAM,
  })
  for (let row = 0; row < modules.size; row += 1) {
    for (let column = 0; column < modules.size; column += 1) {
      if (!modules.data[row * modules.size + column]) continue
      page.drawRectangle({
        x: origin.x + (column + quiet) * cell,
        y: origin.y + (modules.size - 1 - row + quiet) * cell,
        width: cell,
        height: cell,
        color: NAVY,
      })
    }
  }
}

Deno.serve(async (request) => {
  const headers = cors(request.headers.get('origin'))
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers })

  const authHeader = request.headers.get('authorization')
  if (!authHeader) return Response.json({ error: 'Authentication required' }, { status: 401, headers })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await anon.auth.getUser()
  if (!user) return Response.json({ error: 'Invalid session' }, { status: 401, headers })

  let certificateId = ''
  let token = ''
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const body = await request.json().catch(() => null)
    const enrollmentId = typeof body?.enrollmentId === 'string' ? body.enrollmentId : ''
    if (!enrollmentId) throw new Error('An enrollment is required')

    const ensured = await anon.rpc('ensure_certificate', { target_enrollment: enrollmentId })
    if (ensured.error) throw ensured.error
    certificateId = ensured.data.id
    if (ensured.data.status === 'active') {
      return Response.json({ certificateId, verificationId: ensured.data.verification_id, status: 'active' }, { headers })
    }

    token = crypto.randomUUID()
    const claimResult = await service.rpc('claim_certificate_generation', {
      target_certificate: certificateId,
      worker_token: token,
    })
    if (claimResult.error) throw claimResult.error
    const claim = claimResult.data as {
      claimed: boolean
      status: string
      studentName: string
      courseTitle: string
      completedAt: string
      verificationId: string
      requiredModuleCount: number
      templateVersion: number
      templateSha256: string
      templateObjectPath: string
      objectPath: string
    }
    if (!claim.claimed) {
      return Response.json({ certificateId, verificationId: claim.verificationId, status: claim.status }, { status: 202, headers })
    }
    if (claim.templateVersion !== 2 && claim.templateVersion !== 3) {
      throw new Error('Unsupported certificate template version')
    }
    if (claim.templateVersion === 3 && claim.requiredModuleCount !== TEMPLATE_MODULE_COUNT) {
      throw new Error('The certificate template does not match the required curriculum length')
    }

    const templateDownload = await service.storage.from('certificate-templates').download(claim.templateObjectPath)
    if (templateDownload.error) throw new Error('Certificate template is unavailable')
    const template = new Uint8Array(await templateDownload.data.arrayBuffer())
    if (await sha256(template) !== claim.templateSha256) throw new Error('Certificate template integrity check failed')

    const origin = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)[0]
    if (!origin) throw new Error('No public application origin is configured')
    const verificationUrl = `${origin.replace(/\/+$/, '')}/verify/${claim.verificationId}`

    const document = await PDFDocument.create()
    const bold = await document.embedFont(StandardFonts.TimesRomanBold)
    const italic = await document.embedFont(StandardFonts.TimesRomanItalic)
    let page: ReturnType<PDFDocument['addPage']>

    if (claim.templateVersion === 3) {
      // Use the supplied artwork as vector PDF so its type and rules stay sharp.
      const source = await PDFDocument.load(template)
      const { width, height } = source.getPage(0).getSize()
      const [artwork] = await document.embedPdf(template)
      page = document.addPage([width, height])
      page.drawPage(artwork)
    } else {
      const background = await document.embedPng(template)
      page = document.addPage([841.68, 595.44])
      page.drawImage(background, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
    }

    // Student name over the template's "Student Name" placeholder.
    page.drawRectangle({ x: 200, y: 343, width: 445, height: 46, color: CREAM })
    const nameSize = fittedSize(bold, claim.studentName, 620, 38, 20)
    page.drawText(claim.studentName, {
      x: centredX(bold, claim.studentName, nameSize, page.getWidth() / 2),
      y: 349.9,
      size: nameSize,
      font: bold,
      color: NAVY,
    })

    // Completion date above the left signature rule.
    const issuedDate = new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric',
    }).format(new Date(claim.completedAt))
    page.drawText(issuedDate, {
      x: centredX(italic, issuedDate, 14, 205.2),
      y: 110,
      size: 14,
      font: italic,
      color: NAVY,
    })

    // Unique certificate id over the template's sample id.
    page.drawRectangle({ x: 325, y: 36, width: 175, height: 14, color: CREAM })
    const identifier = `Certificate ID: ${claim.verificationId}`
    page.drawText(identifier, {
      x: centredX(italic, identifier, 11, page.getWidth() / 2),
      y: 43.5,
      size: 11,
      font: italic,
      color: NAVY,
    })

    // Scannable verification block in the empty lower-left area.
    drawQr(page, verificationUrl, { x: 60, y: 38, size: 34 })
    const verificationLeft = 104
    const verificationWidth = 250
    const address = `${new URL(verificationUrl).host}/verify/`
    page.drawText(address, {
      x: verificationLeft,
      y: 66,
      size: fittedSize(italic, address, verificationWidth, 9, 6),
      font: italic,
      color: NAVY,
    })
    page.drawText(claim.verificationId, {
      x: verificationLeft,
      y: 53,
      size: fittedSize(italic, claim.verificationId, verificationWidth, 9, 6),
      font: italic,
      color: NAVY,
    })

    document.setTitle(`${claim.courseTitle} certificate - ${claim.studentName}`)
    document.setAuthor('Logistics VA Training Academy')
    document.setCreationDate(new Date())
    const pdf = await document.save({ useObjectStreams: false })
    const pdfHash = await sha256(pdf)

    const uploaded = await service.storage.from('certificates').upload(claim.objectPath, pdf, {
      contentType: 'application/pdf',
      upsert: false,
    })
    if (uploaded.error) throw uploaded.error

    const completed = await service.rpc('complete_certificate_generation', {
      target_certificate: certificateId,
      worker_token: token,
      generated_object_path: claim.objectPath,
      generated_sha256: pdfHash,
      generated_size: pdf.byteLength,
    })
    if (completed.error) throw completed.error

    return Response.json(
      { certificateId, verificationId: claim.verificationId, status: 'active' },
      { status: 201, headers },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Certificate generation failed'
    if (certificateId && token) {
      await service.rpc('fail_certificate_generation', {
        target_certificate: certificateId,
        worker_token: token,
        failure: message,
      })
    }
    return Response.json({ error: message }, { status: 403, headers })
  }
})
