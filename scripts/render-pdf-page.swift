import AppKit
import Foundation
import PDFKit

// Renders the first page of a PDF to PNG so a layout can actually be inspected.
// Text extraction is not enough here because the certificate design is artwork.
let args = CommandLine.arguments
guard args.count == 3 else {
  fputs("usage: swift scripts/render-pdf-page.swift <input.pdf> <output.png>\n", stderr)
  exit(2)
}
guard
  let document = PDFDocument(url: URL(fileURLWithPath: args[1])),
  let page = document.page(at: 0)
else {
  fputs("unable to read PDF\n", stderr)
  exit(1)
}
let bounds = page.bounds(for: PDFDisplayBox.mediaBox)
let scale: CGFloat = 2
let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
let image = NSImage(size: size)
image.lockFocus()
if let context = NSGraphicsContext.current?.cgContext {
  context.setFillColor(NSColor.white.cgColor)
  context.fill(CGRect(origin: .zero, size: size))
  context.scaleBy(x: scale, y: scale)
  page.draw(with: PDFDisplayBox.mediaBox, to: context)
}
image.unlockFocus()
guard
  let tiff = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiff),
  let png = bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:])
else {
  fputs("unable to encode PNG\n", stderr)
  exit(1)
}
try png.write(to: URL(fileURLWithPath: args[2]))
print("rendered \(args[1]) page 1 (\(Int(bounds.width))x\(Int(bounds.height))pt) -> \(args[2])")