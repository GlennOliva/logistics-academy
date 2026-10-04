export const MAX_PROOF_BYTES = 10 * 1024 * 1024
export const PROOF_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const

export function validateProofFile(file: Pick<File, 'size' | 'type'>) {
  if (!PROOF_TYPES.includes(file.type as (typeof PROOF_TYPES)[number])) {
    return 'Use a JPG, PNG, or PDF file.'
  }
  if (file.size < 1 || file.size > MAX_PROOF_BYTES) {
    return 'The proof must be no larger than 10 MB.'
  }
  return null
}

export const MATERIAL_MAX_BYTES = 50 * 1024 * 1024

export const MATERIAL_FORMATS = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const

export type MaterialFormat = keyof typeof MATERIAL_FORMATS

const MATERIAL_MIME_TYPES: Record<string, MaterialFormat> = Object.entries(MATERIAL_FORMATS).reduce(
  (map, [format, mime]) => {
    map[mime] = format as MaterialFormat
    return map
  },
  {} as Record<string, MaterialFormat>,
)

const MATERIAL_EXTENSIONS: Record<MaterialFormat, string> = {
  pdf: '.pdf',
  ppt: '.ppt',
  pptx: '.pptx',
}

const MATERIAL_LABELS: Record<MaterialFormat, string> = {
  pdf: 'PDF',
  ppt: 'PowerPoint (.ppt)',
  pptx: 'PowerPoint (.pptx)',
}

// The browser MIME type is only a hint and is empty or wrong for plenty of real
// files, so the extension is read as a second, independent declaration. This is a
// convenience check on the trainer's own machine; the edge function still
// verifies the real file signature and refuses anything that does not match.
export function materialFormatOf(file: Pick<File, 'type' | 'name'>): MaterialFormat | null {
  const { byMime, byExtension } = describeMaterialFile(file)
  if (byMime && byExtension && byMime !== byExtension) return null
  return byMime ?? byExtension
}

function describeMaterialFile(file: Pick<File, 'type' | 'name'>) {
  const declared = file.type.toLowerCase().split(';')[0].trim()
  const byMime = declared in MATERIAL_MIME_TYPES ? MATERIAL_MIME_TYPES[declared] : null

  const name = file.name.toLowerCase()
  const byExtension =
    (Object.keys(MATERIAL_EXTENSIONS) as MaterialFormat[])
      .slice()
      .sort((a, b) => MATERIAL_EXTENSIONS[b].length - MATERIAL_EXTENSIONS[a].length)
      .find((format) => name.endsWith(MATERIAL_EXTENSIONS[format])) ?? null

  // ".pdf.exe" ends with a real extension, it is just not one we accept. This
  // separates "no extension at all" from "a deliberately disguised extension".
  const hasUnusableExtension = /\.[a-z0-9]+$/.test(name) && byExtension === null

  return { byMime, byExtension, hasUnusableExtension }
}

export function validateMaterialFile(file: Pick<File, 'size' | 'type' | 'name'>) {
  const { byMime, byExtension, hasUnusableExtension } = describeMaterialFile(file)

  // A .ppt deck is the legacy OLE2 container and a .pptx is OOXML/ZIP. When the
  // extension and the declared type disagree the file has been renamed, and
  // accepting it would store the wrong bytes under the wrong name.
  if (byMime && byExtension && byMime !== byExtension) {
    const claimed = MATERIAL_EXTENSIONS[byExtension].slice(1).toUpperCase()
    return `This looks like a ${claimed} file renamed to .${byMime}. Use its real extension and format.`
  }

  const format = byMime ?? byExtension
  if (!format) {
    return 'Course material must be a PDF or PowerPoint file (.pdf, .ppt, or .pptx).'
  }

  // A recognised MIME type is not enough on its own: a file named
  // "lesson.pdf.exe" is not course material.
  if (hasUnusableExtension) {
    return 'Course material must be a PDF or PowerPoint file (.pdf, .ppt, or .pptx), with a matching filename.'
  }

  if (file.size < 1) return `Course material must be an actual ${MATERIAL_LABELS[format]} file.`
  if (file.size > MATERIAL_MAX_BYTES) {
    return 'Course material must be no larger than 50 MB.'
  }
  return null
}

const manilaDate = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila' })
const manilaDateTime = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  dateStyle: 'medium',
  timeStyle: 'short',
})

export function formatManilaDate(iso: string) {
  return manilaDate.format(new Date(iso))
}

export function formatManilaDateTime(iso: string) {
  return manilaDateTime.format(new Date(iso))
}

export function statusLabel(value: string) {
  return value.replace(/_/g, ' ').replace(/^\w/, (character) => character.toUpperCase())
}

/**
 * The database stores money as integer centavos so no rounding error can enter
 * the system. Only the display layer converts back to pesos.
 */
const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })

export function formatCentavos(centavos: number) {
  return peso.format(centavos / 100)
}