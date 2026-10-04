import { describe, expect, it } from 'vitest'
import {
  MATERIAL_MAX_BYTES,
  MAX_PROOF_BYTES,
  formatCentavos,
  statusLabel,
  validateMaterialFile,
  validateProofFile,
} from './payment'

describe('validateProofFile', () => {
  it.each(['image/jpeg', 'image/png', 'application/pdf'])('accepts supported %s proof', (type) => {
    expect(validateProofFile({ type, size: 1024 })).toBeNull()
  })

  it('rejects extension-only or executable uploads', () => {
    expect(validateProofFile({ type: 'application/octet-stream', size: 1024 })).toMatch(/JPG/)
  })

  it('rejects empty and oversized proof files', () => {
    expect(validateProofFile({ type: 'image/png', size: 0 })).toMatch(/10 MB/)
    expect(validateProofFile({ type: 'image/png', size: MAX_PROOF_BYTES + 1 })).toMatch(/10 MB/)
  })

  it('accepts a file at exactly the size limit', () => {
    expect(validateProofFile({ type: 'image/png', size: MAX_PROOF_BYTES })).toBeNull()
  })
})

describe('validateMaterialFile', () => {
  it('accepts a PDF, PPT and PPTX within the limit', () => {
    expect(validateMaterialFile({ type: 'application/pdf', name: 'module-1.pdf', size: 2048 })).toBeNull()
    expect(
      validateMaterialFile({ type: 'application/vnd.ms-powerpoint', name: 'module-1.ppt', size: 2048 }),
    ).toBeNull()
    expect(
      validateMaterialFile({
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: 'module-1.pptx',
        size: 2048,
      }),
    ).toBeNull()
  })

  it('falls back to the extension when the browser reports no MIME type', () => {
    expect(validateMaterialFile({ type: '', name: 'module-1.ppt', size: 2048 })).toBeNull()
    expect(validateMaterialFile({ type: '', name: 'module-1.pptx', size: 2048 })).toBeNull()
  })

  it('refuses anything that is not PDF or PowerPoint', () => {
    expect(validateMaterialFile({ type: 'image/png', name: 'module-1.png', size: 2048 })).toMatch(
      /PDF or PowerPoint/,
    )
    expect(validateMaterialFile({ type: '', name: 'module-1.key', size: 2048 })).toMatch(
      /PDF or PowerPoint/,
    )
    expect(validateMaterialFile({ type: 'application/pdf', name: 'module-1.pdf.exe', size: 2048 })).toMatch(
      /PDF or PowerPoint/,
    )
  })

  it('refuses a deck whose extension contradicts its declared type', () => {
    expect(
      validateMaterialFile({
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: 'renamed.ppt',
        size: 2048,
      }),
    ).toMatch(/renamed/)
    expect(
      validateMaterialFile({
        type: 'application/vnd.ms-powerpoint',
        name: 'renamed.pptx',
        size: 2048,
      }),
    ).toMatch(/renamed/)
  })

  it('refuses empty and oversized material', () => {
    expect(validateMaterialFile({ type: 'application/pdf', name: 'm.pdf', size: 0 })).toMatch(/50 MB|PDF|actual/)
    expect(
      validateMaterialFile({ type: 'application/pdf', name: 'm.pdf', size: MATERIAL_MAX_BYTES + 1 }),
    ).toMatch(/50 MB/)
    expect(
      validateMaterialFile({
        type: 'application/vnd.ms-powerpoint',
        name: 'm.ppt',
        size: MATERIAL_MAX_BYTES + 1,
      }),
    ).toMatch(/50 MB/)
  })
})

describe('formatCentavos', () => {
  // The database stores integer centavos. Dividing twice is an easy mistake that
  // would silently show ₱6.99 for a ₱699 course.
  it('renders pesos from centavos', () => {
    expect(formatCentavos(69900)).toContain('699')
  })

  it('does not divide an already converted amount again', () => {
    expect(formatCentavos(69900)).not.toContain('6.99')
  })

  it('handles zero', () => {
    expect(formatCentavos(0)).toMatch(/0/)
  })
})

describe('statusLabel', () => {
  it('turns stored enum values into readable text', () => {
    expect(statusLabel('resubmission_required')).toBe('Resubmission required')
    expect(statusLabel('approved')).toBe('Approved')
  })
})