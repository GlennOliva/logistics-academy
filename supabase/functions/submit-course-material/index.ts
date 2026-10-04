import { createClient } from 'npm:@supabase/supabase-js@2'

const MAX_MATERIAL_BYTES = 50 * 1024 * 1024

function cors(origin: string | null) {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

const PDF_MIME = 'application/pdf'
const PPT_MIME = 'application/vnd.ms-powerpoint'
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
function isPdf(bytes: Uint8Array) {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') return false
  // A five byte prefix is trivial to forge, so a real trailer is required too.
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)))
  return tail.includes('%%EOF')
}

function isOle2(bytes: Uint8Array) {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  return signature.every((byte, index) => bytes[index] === byte)
}

function isZip(bytes: Uint8Array) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function u32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

// Walks the OLE2 compound file directory looking for a real "PowerPoint
// Document" stream. The eight byte signature matches every legacy Office file,
// so a Word or Excel document renamed to .ppt would otherwise be accepted as
// paid course material.
function hasPowerpointStream(bytes: Uint8Array) {
  if (!isOle2(bytes) || bytes.length < 1024) return false

  const sectorShift = u16(bytes, 0x1e)
  if (sectorShift !== 9 && sectorShift !== 12) return false
  const sectorSize = 1 << sectorShift

  const directoryStart = u32(bytes, 0x30)
  const fatSectorCount = u32(bytes, 0x2c)
  if (fatSectorCount < 1) return false
  const fatStart = u32(bytes, 0x4c)

  const maxSectors = Math.floor((bytes.length - 512) / sectorSize)
  const sectorOffset = (sector: number) => 512 + sector * sectorSize
  if (sectorOffset(fatStart) + sectorSize > bytes.length) return false

  const seen = new Set<number>()
  let sector = directoryStart

  while (sector !== 0xfffffffe && sector !== 0xffffffff && !seen.has(sector)) {
    if (sector >= maxSectors) return false
    seen.add(sector)

    const base = sectorOffset(sector)
    for (let entry = 0; entry < sectorSize / 128; entry += 1) {
      const offset = base + entry * 128
      if (offset + 128 > bytes.length) break
      const nameLength = u16(bytes, offset + 64)
      // 2 is an empty name and 128 marks an unallocated directory entry.
      if (nameLength < 4 || nameLength > 64) continue
      const name = new TextDecoder('utf-16le')
        .decode(bytes.subarray(offset, offset + nameLength - 2))
        .replace(/\0+$/, '')
      if (name === 'PowerPoint Document') return true
    }

    // Continue along the FAT chain to the next directory sector.
    const fatEntriesPerSector = sectorSize / 4
    const fatIndex = Math.floor(sector / fatEntriesPerSector)
    const fatOffset = sectorOffset(fatStart + fatIndex) + (sector % fatEntriesPerSector) * 4
    if (fatOffset + 4 > bytes.length) return false
    sector = u32(bytes, fatOffset)
  }

  return false
}

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number }

// Reads the ZIP central directory instead of scanning for strings, so entry
// names come from the archive structure rather than from anything a caller can
// place in a comment or inside a compressed member.
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const floor = Math.max(0, bytes.length - (0xffff + 22))
  let eocd = -1
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []

  const count = u16(bytes, eocd + 10)
  let offset = u32(bytes, eocd + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length) break
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x01 ||
      bytes[offset + 3] !== 0x02
    ) {
      break
    }
    const method = u16(bytes, offset + 10)
    const compressedSize = u32(bytes, offset + 20)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const localOffset = u32(bytes, offset + 42)
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

// The local file header is 30 bytes before the name, with the name length at
// offset 26 and the extra field length at offset 28.
function zipDataOffset(bytes: Uint8Array, entry: ZipEntry) {
  const header = entry.localOffset
  if (header + 30 > bytes.length) return -1
  if (bytes[header] !== 0x50 || bytes[header + 1] !== 0x4b || bytes[header + 2] !== 0x03 || bytes[header + 3] !== 0x04) {
    return -1
  }
  return header + 30 + u16(bytes, header + 26) + u16(bytes, header + 28)
}

// A genuine .pptx is an OOXML package whose content types declare the
// presentation main part, with a presentation part and at least one slide. The
// ZIP signature alone is never enough.
async function isPowerpointPptx(bytes: Uint8Array) {
  if (!isZip(bytes)) return false
  const entries = zipEntries(bytes)
  if (entries.length === 0) return false

  const contentTypesEntry = entries.find((entry) => entry.name === '[Content_Types].xml')
  const presentationEntry = entries.find((entry) => entry.name === 'ppt/presentation.xml')
  if (!contentTypesEntry || !presentationEntry) return false
  if (!entries.some((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))) return false

  const start = zipDataOffset(bytes, contentTypesEntry)
  if (start < 0) return false
  const raw = bytes.subarray(start, start + contentTypesEntry.compressedSize)

  let declaration: string | null = null
  if (contentTypesEntry.method === 0) {
    declaration = new TextDecoder('utf-8').decode(raw)
  } else if (contentTypesEntry.method === 8) {
    const inflated = await inflateRaw(raw)
    declaration = inflated ? new TextDecoder('utf-8').decode(inflated) : null
  }

  if (!declaration) return false
  return (
    declaration.includes('presentationml.presentation.main+xml') &&
    declaration.includes('/ppt/presentation.xml')
  )
}

type Detected = { type: 'pdf' | 'ppt' | 'pptx'; ext: string; contentType: string }

// The stored format is decided by the real bytes, never by the filename or by
// the browser's MIME type, which is frequently absent or wrong. The declared
// type is only used to cross-check, so a renamed file is refused rather than
// stored under an extension that does not match its contents.
async function detectType(bytes: Uint8Array, mime: string, filename: string) {
  let type: Detected['type'] | null = null
  let rejection = ''

  if (isPdf(bytes)) {
    type = 'pdf'
  } else if (await isPowerpointPptx(bytes)) {
    type = 'pptx'
  } else if (hasPowerpointStream(bytes)) {
    type = 'ppt'
  } else if (isZip(bytes)) {
    rejection =
      'This ZIP archive is not a PowerPoint presentation. A .pptx file must contain [Content_Types].xml, ppt/presentation.xml and at least one slide.'
  } else if (isOle2(bytes)) {
    rejection =
      'This is a legacy Office document but not a PowerPoint presentation, so it cannot be saved as a .ppt lesson.'
  } else {
    rejection =
      'Course material must be a real PDF, PPT, or PPTX file. The file contents do not match any supported format.'
  }

  if (!type) return { detected: null, rejection }

  const contentType = type === 'pdf' ? PDF_MIME : type === 'ppt' ? PPT_MIME : PPTX_MIME
  const extension = /\.([a-z0-9]+)$/.exec(filename.toLowerCase())?.[1] ?? ''

  if (extension && extension !== type) {
    return {
      detected: null,
      rejection: `This is a .${type} file named .${extension}. Upload it using its real file extension.`,
    }
  }

  const declared = mime.toLowerCase().split(';')[0].trim()
  const declaredType =
    declared === PDF_MIME ? 'pdf' : declared === PPT_MIME ? 'ppt' : declared === PPTX_MIME ? 'pptx' : null
  if (declaredType && declaredType !== type) {
    return {
      detected: null,
      rejection: `This file is a .${type} but was sent as .${declaredType}. Upload it using its real format.`,
    }
  }

  return { detected: { type, ext: type, contentType }, rejection: '' }
}

function safeFilename(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'material.pdf'
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

  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Role is re-checked in Postgres as well, so a function bug cannot let a
  // student upload paid material.
  const { data: isAdmin } = await anon.rpc('is_admin', { target_user: user.id })
  if (isAdmin !== true) return Response.json({ error: 'Administrator role required' }, { status: 403, headers })

  try {
    const form = await request.formData()
    const file = form.get('material')
    if (!(file instanceof File)) throw new Error('A material file is required')
    if (file.size < 1) throw new Error('The selected file is empty. Choose a PDF or PowerPoint file.')
    // The 50 MB ceiling is checked before the whole body is buffered so an
    // oversized file cannot be used to exhaust the function.
    if (file.size > MAX_MATERIAL_BYTES) {
      throw new Error('Course material must be a PDF or PowerPoint file of 50 MB or less.')
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const { detected, rejection } = await detectType(bytes, file.type, file.name)
    if (!detected) throw new Error(rejection)

    const moduleId = String(form.get('moduleId') ?? '')
    const language = String(form.get('language') ?? '')
    const title = String(form.get('title') ?? '').trim()
    const summary = String(form.get('summary') ?? '')
    const publishNow = String(form.get('publishNow') ?? 'false') === 'true'
    if (!moduleId) throw new Error('A module is required')
    if (title.length === 0) throw new Error('A title is required')
    if (language !== 'en' && language !== 'ceb') throw new Error('Choose English or Bisaya')

    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

    // Immutable, content-addressed path. Re-uploading the same bytes produces the
    // same name, which makes a stale upload visibly idempotent rather than
    // silently creating a duplicate version.
    const objectPath = `course/${moduleId}/${language}/${sha256.slice(0, 16)}.${detected.ext}`
    const upload = await service.storage.from('course-materials').upload(objectPath, bytes, {
      contentType: detected.contentType,
      upsert: true,
    })
    if (upload.error) throw upload.error

    const saved = await service.rpc('admin_save_module_translation', {
      caller_user: user.id,
      target_module: moduleId,
      translation_language: language,
      translation_title: title,
      translation_summary: summary,
      asset_object_path: objectPath,
      asset_sha256: sha256,
      asset_size_bytes: file.size,
      publish_now: publishNow,
    })
    if (saved.error) {
      // Only remove the object when this call created it and nothing references it.
      const { data: stillReferenced } = await service
        .from('module_translations')
        .select('id')
        .eq('object_path', objectPath)
        .maybeSingle()
      if (!stillReferenced) await service.storage.from('course-materials').remove([objectPath])
      throw saved.error
    }

    return Response.json({ ...(saved.data as object), fileName: safeFilename(file.name) }, { status: 201, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save module material'
    return Response.json({ error: message }, { status: 400, headers })
  }
})
