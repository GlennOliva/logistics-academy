#!/usr/bin/env node
// Extracts positioned text runs from a PDF page, decoding subset fonts through
// their ToUnicode CMaps and recursing into form XObjects (which is how pdf-lib
// embeds a template page). Used to assert that a generated certificate keeps the
// supplied template artwork and places its dynamic fields correctly.
//
// usage: node scripts/pdf-text-layout.mjs <input.pdf>

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/pdf-text-layout.mjs <input.pdf>')
  process.exit(2)
}
const buffer = readFileSync(path)
const raw = buffer.toString('latin1')

function objectOffset(number) {
  const match = new RegExp(`(?:^|[^0-9])${number}\\s+0\\s+obj`).exec(raw)
  return match ? match.index + match[0].length : -1
}

function objectBody(number) {
  const offset = objectOffset(number)
  if (offset === -1) return ''
  const end = raw.indexOf('endobj', offset)
  return end === -1 ? '' : raw.slice(offset, end)
}

function streamData(number) {
  const body = objectBody(number)
  const marker = /stream\r?\n/.exec(body)
  if (!marker) return ''
  const from = marker.index + marker[0].length
  const end = body.lastIndexOf('endstream')
  if (end <= from) return ''
  const offset = objectOffset(number)
  const slice = buffer.subarray(offset + from, offset + end)
  try {
    return inflateSync(slice).toString('latin1')
  } catch {
    return slice.toString('latin1')
  }
}

// Extracts the balanced << ... >> dictionary that starts at or after `from`.
// All offsets are relative to the string being searched.
function dictionaryIn(body, from) {
  const start = body.indexOf('<<', from)
  if (start === -1) return ''
  let depth = 0
  for (let i = start; i < body.length - 1; i += 1) {
    if (body[i] === '<' && body[i + 1] === '<') {
      depth += 1
      i += 1
    } else if (body[i] === '>' && body[i + 1] === '>') {
      depth -= 1
      i += 1
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  return ''
}

function dictionaryAround(index) {
  const prefix = raw.slice(0, index)
  const headers = [...prefix.matchAll(/(?:^|[^0-9])(\d+)\s+0\s+obj/g)]
  if (!headers.length) return ''
  const header = headers[headers.length - 1]
  return dictionaryIn(raw, header.index + header[0].length)
}

function pageDictionary() {
  const match = /\/Type\s*\/Page(?![s])/.exec(raw)
  return match ? dictionaryAround(match.index) : ''
}

// Resolves `/Key` to a dictionary body whether it is inline or indirect.
function resolveDictionary(body, key) {
  const at = body.indexOf(`/${key}`)
  if (at === -1) return ''
  const indirect = new RegExp(`^/${key}\\s+(\\d+)\\s+0\\s+R`).exec(body.slice(at))
  if (indirect) return objectBody(Number(indirect[1]))
  return dictionaryIn(body, at)
}

function parseCmap(text) {
  const map = new Map()
  for (const section of text.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
    for (const [, src, dst] of section.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      let out = ''
      for (let i = 0; i + 3 < dst.length + 1; i += 4) out += String.fromCharCode(parseInt(dst.slice(i, i + 4), 16))
      map.set(parseInt(src, 16), out)
    }
  }
  for (const section of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
    for (const [, lo, hi, dst] of section.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(lo, 16)
      const base = parseInt(dst, 16)
      for (let code = start; code <= parseInt(hi, 16); code += 1) map.set(code, String.fromCharCode(base + code - start))
    }
  }
  return map
}

function parseResources(body) {
  const fonts = new Map()
  for (const [, name, number] of resolveDictionary(body, 'Font').matchAll(/\/([^\s/[\]()<>{}]+)\s+(\d+)\s+0\s+R/g)) {
    const fontBody = objectBody(Number(number))
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontBody)
    const base = /\/BaseFont\s*\/([\w+-]+)/.exec(fontBody)
    fonts.set(name, {
      map: toUnicode ? parseCmap(streamData(Number(toUnicode[1]))) : new Map(),
      base: base ? base[1].replace(/^[A-Z]{6}\+/, '') : name,
    })
  }
  const xobjects = new Map()
  for (const [, name, number] of resolveDictionary(body, 'XObject').matchAll(/\/([^\s/[\]()<>{}]+)\s+(\d+)\s+0\s+R/g)) {
    xobjects.set(name, Number(number))
  }
  return { fonts, xobjects }
}

function contentsOf(body) {
  const refs = []
  const inline = /\/Contents\s+(\d+)\s+0\s+R/.exec(body)
  if (inline) refs.push(Number(inline[1]))
  const array = /\/Contents\s*\[([^\]]*)\]/.exec(body)
  if (array) for (const [, number] of array[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(Number(number))
  return [...new Set(refs)].map(streamData).join('\n')
}

const page = pageDictionary()
const box = /\/MediaBox\s*\[\s*([^\]]*)\]/.exec(page)
const [boxWidth, boxHeight] = (box ? box[1] : '0 0 595 842').trim().split(/\s+/).slice(2).map(Number)
const pageResources = parseResources(resolveDictionary(page, 'Resources'))

const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]
const translate = (tx, ty) => [1, 0, 0, 1, tx, ty]

function decodeHex(hex, font) {
  let out = ''
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    out += font?.map.get(code) ?? String.fromCharCode(code)
  }
  return out
}

function decodeLiteral(literal, font) {
  const body = literal.slice(1, -1)
  if (!font?.map.size) {
    return body.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c)
  }
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') i += 1
    out += font.map.get(body.charCodeAt(i)) ?? body[i]
  }
  return out
}

const runs = []
const tokenPattern =
  /\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>|\[|\]|[-+]?[\d.]+|\/[^\s/[\]()<>{}]+|[A-Za-z'"*][A-Za-z0-9*'"]*/g

function scan(content, resources, baseCtm, depth) {
  let font = null
  let fontSize = 12
  let leading = 0
  let ctm = [...baseCtm]
  let lineMatrix = [1, 0, 0, 1, 0, 0]
  let textMatrix = [1, 0, 0, 1, 0, 0]
  const stack = []

  const place = () => {
    const matrix = multiply([fontSize, 0, 0, fontSize, 0, 0], multiply(textMatrix, ctm))
    return { x: matrix[4], y: matrix[5], size: Math.hypot(matrix[0], matrix[1]) || fontSize }
  }

  let operands = []
  for (const token of content.match(tokenPattern) || []) {
    if (/^[-+]?[\d.]+$/.test(token)) {
      operands.push(Number(token))
      continue
    }
    if (token.startsWith('(') || token.startsWith('<') || token.startsWith('/') || token === '[' || token === ']') {
      operands.push(token)
      continue
    }

    switch (token) {
      case 'q':
        stack.push([...ctm])
        break
      case 'Q':
        ctm = stack.pop() ?? ctm
        break
      case 'cm':
        ctm = multiply(operands.slice(-6), ctm)
        break
      case 'BT':
        lineMatrix = [1, 0, 0, 1, 0, 0]
        textMatrix = [1, 0, 0, 1, 0, 0]
        break
      case 'Tf':
        font = resources.fonts.get(String(operands.at(-2) ?? '').replace(/^\//, '')) ?? null
        fontSize = operands.at(-1) ?? 12
        break
      case 'TL':
        leading = operands.at(-1) ?? 0
        break
      case 'Tm':
        lineMatrix = operands.slice(-6)
        textMatrix = lineMatrix
        break
      case 'Td':
        lineMatrix = multiply(translate(operands.at(-2) ?? 0, operands.at(-1) ?? 0), lineMatrix)
        textMatrix = lineMatrix
        break
      case 'TD':
        leading = -(operands.at(-1) ?? 0)
        lineMatrix = multiply(translate(operands.at(-2) ?? 0, operands.at(-1) ?? 0), lineMatrix)
        textMatrix = lineMatrix
        break
      case 'T*':
        lineMatrix = multiply(translate(0, -leading), lineMatrix)
        textMatrix = lineMatrix
        break
      case 'Tj':
      case 'TJ': {
        const show = (value) =>
          value.startsWith('<') ? decodeHex(value.slice(1, -1).replace(/\s/g, ''), font) : decodeLiteral(value, font)
        const text =
          token === 'Tj'
            ? show(String(operands.at(-1)))
            : operands
                .filter((value) => typeof value === 'string' && (value.startsWith('<') || value.startsWith('(')))
                .map(show)
                .join('')
        if (text.trim()) runs.push({ ...place(), font: font?.base, text })
        break
      }
      case 'Do': {
        if (process.env.PDF_LAYOUT_DEBUG) console.error('Do', operands.at(-1), 'depth', depth)
        if (depth < 6) {
          const name = String(operands.at(-1) ?? '').replace(/^\//, '')
          const number = resources.xobjects.get(name)
          const body = number ? objectBody(number) : ''
          if (/\/Subtype\s*\/Form/.test(body)) {
            const matrix = /\/Matrix\s*\[([^\]]*)\]/.exec(body)
            const form = matrix
              ? matrix[1].trim().split(/\s+/).slice(0, 6).map(Number)
              : [1, 0, 0, 1, 0, 0]
            if (process.env.PDF_LAYOUT_DEBUG) console.error('  form xobject', number, 'len', streamData(number).length)
          const nested = resolveDictionary(body, 'Resources')
            scan(
              streamData(number),
              nested ? parseResources(nested) : resources,
              multiply(form, ctm),
              depth + 1,
            )
          }
        }
        break
      }
      default:
        break
    }
    operands = []
  }
}

if (process.env.PDF_LAYOUT_DEBUG) {
  console.error('page dict len', page.length, JSON.stringify(page.slice(0, 120)))
  console.error('resolved resources', JSON.stringify(resolveDictionary(page, 'Resources').slice(0, 160)))
  console.error('font dict', JSON.stringify(resolveDictionary(resolveDictionary(page, 'Resources'), 'Font').slice(0, 120)))
  console.error('name regex hits', [...resolveDictionary(resolveDictionary(page, 'Resources'), 'Font').matchAll(/\/([^\s/[\]()<>{}]+)\s+(\d+)\s+0\s+R/g)].length)
  console.error('fonts', [...pageResources.fonts.keys()])
  console.error('xobjects', [...pageResources.xobjects.keys()])
  console.error('content length', contentsOf(page).length)
}
scan(contentsOf(page), pageResources, [1, 0, 0, 1, 0, 0], 0)

console.log(`page=${boxWidth.toFixed(1)}x${boxHeight.toFixed(1)}pt runs=${runs.length}`)
console.log('x      y      size  font                     text')
for (const run of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
  console.log(
    `${run.x.toFixed(1).padStart(7)} ${run.y.toFixed(1).padStart(7)} ${run.size.toFixed(1).padStart(5)}  ${(run.font ?? '-').padEnd(22)}  ${run.text}`,
  )
}