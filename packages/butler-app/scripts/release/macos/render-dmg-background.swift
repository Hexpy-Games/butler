// Renders the Butler DMG window background (1x + 2x in one TIFF).
//
//   swift packages/butler-app/scripts/release/macos/render-dmg-background.swift \
//     packages/butler-app/client/electron/assets/butler-mark-flat.png \
//     packages/butler-app/scripts/release/macos/dmg-background.tiff
//
// The geometry matches DMG_LAYOUT in ../mac-dmg.ts: a 660x400 pt window with
// Butler.app centred at (170, 200) and Applications at (490, 200), 128 pt icons.
// Colours are the design-system grayscale ramp so the window reads as Butler.
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 3, let mark = NSImage(contentsOfFile: arguments[1]) else {
  FileHandle.standardError.write(Data("usage: render-dmg-background.swift <mark.png> <output.tiff>\n".utf8))
  exit(64)
}
let outputPath = arguments[2]

let canvas = NSSize(width: 660, height: 400)
let appCenter = NSPoint(x: 170, y: 200)
let applicationsCenter = NSPoint(x: 490, y: 200)
let iconSize: CGFloat = 128

func gray(_ hex: Int) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: 1
  )
}

let base = gray(0xf8f9fa)      // grayscale-01
let well = gray(0xf2f3f4)      // grayscale-02
let hairline = gray(0xe9eaec)  // grayscale-03
let arrow = gray(0xc2c4c7)     // grayscale-05
let caption = gray(0x71767d)   // grayscale-07
let ink = gray(0x26282c)       // grayscale-10

// Artwork is described with a top-left origin, like Finder icon positions.
func flip(_ rect: NSRect) -> NSRect {
  NSRect(x: rect.minX, y: canvas.height - rect.maxY, width: rect.width, height: rect.height)
}

func flip(_ point: NSPoint) -> NSPoint {
  NSPoint(x: point.x, y: canvas.height - point.y)
}

func drawCentered(_ text: String, font: NSFont, color: NSColor, centerX: CGFloat, top: CGFloat) {
  let string = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
  let size = string.size()
  string.draw(at: flip(NSPoint(x: centerX - size.width / 2, y: top + size.height)))
}

func drawArtwork() {
  base.setFill()
  NSRect(origin: .zero, size: canvas).fill()

  // Soft wells behind the two drop targets, tall enough to hold the Finder label.
  for center in [appCenter, applicationsCenter] {
    let rect = NSRect(x: center.x - 96, y: center.y - 86, width: 192, height: 200)
    let path = NSBezierPath(roundedRect: flip(rect), xRadius: 36, yRadius: 36)
    well.setFill()
    path.fill()
    hairline.setStroke()
    path.lineWidth = 1
    path.stroke()
  }

  // Arrow from the App to Applications.
  let shaftStart = NSPoint(x: appCenter.x + iconSize / 2 + 40, y: appCenter.y)
  let shaftEnd = NSPoint(x: applicationsCenter.x - iconSize / 2 - 40, y: applicationsCenter.y)
  let shaft = NSBezierPath()
  shaft.move(to: flip(shaftStart))
  shaft.line(to: flip(shaftEnd))
  shaft.move(to: flip(NSPoint(x: shaftEnd.x - 11, y: shaftEnd.y - 11)))
  shaft.line(to: flip(shaftEnd))
  shaft.line(to: flip(NSPoint(x: shaftEnd.x - 11, y: shaftEnd.y + 11)))
  shaft.lineWidth = 3
  shaft.lineCapStyle = .round
  shaft.lineJoinStyle = .round
  arrow.setStroke()
  shaft.stroke()

  // Mark + wordmark lockup.
  let wordmark = NSAttributedString(string: "Butler", attributes: [
    .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
    .foregroundColor: ink,
  ])
  let markSize: CGFloat = 30
  let gap: CGFloat = 10
  let wordSize = wordmark.size()
  let lockupWidth = markSize + gap + wordSize.width
  let lockupLeft = (canvas.width - lockupWidth) / 2
  let lockupMiddle: CGFloat = 62
  let markRect = NSRect(x: lockupLeft, y: lockupMiddle - markSize / 2, width: markSize, height: markSize)
  let tinted = NSImage(size: markRect.size, flipped: false) { bounds in
    mark.draw(in: bounds)
    ink.setFill()
    bounds.fill(using: .sourceAtop)
    return true
  }
  tinted.draw(in: flip(markRect))
  wordmark.draw(at: flip(NSPoint(
    x: lockupLeft + markSize + gap,
    y: lockupMiddle + wordSize.height / 2 - 1
  )))

  drawCentered(
    "Drag Butler to Applications",
    font: NSFont.systemFont(ofSize: 13, weight: .regular),
    color: caption,
    centerX: canvas.width / 2,
    top: 334
  )
}

func render(scale: CGFloat) -> NSBitmapImageRep {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(canvas.width * scale),
    pixelsHigh: Int(canvas.height * scale),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    FileHandle.standardError.write(Data("bitmap allocation failed\n".utf8))
    exit(1)
  }
  bitmap.size = canvas
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  context.cgContext.scaleBy(x: scale, y: scale)
  drawArtwork()
  NSGraphicsContext.restoreGraphicsState()
  return bitmap.retagging(with: .sRGB) ?? bitmap
}

// Finder picks the 2x representation on Retina displays; tiffutil checks that
// the second image is exactly twice the first and records both resolutions.
let workDirectory = FileManager.default.temporaryDirectory
  .appendingPathComponent("butler-dmg-background-\(ProcessInfo.processInfo.processIdentifier)")
try? FileManager.default.removeItem(at: workDirectory)
try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: workDirectory) }
var pngPaths: [String] = []
for (scale, name) in [(CGFloat(1), "background.png"), (CGFloat(2), "background@2x.png")] {
  guard let png = render(scale: scale).representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("PNG encoding failed\n".utf8))
    exit(1)
  }
  let url = workDirectory.appendingPathComponent(name)
  try png.write(to: url)
  pngPaths.append(url.path)
}
let tiffutil = Process()
tiffutil.executableURL = URL(fileURLWithPath: "/usr/bin/tiffutil")
tiffutil.arguments = ["-cathidpicheck"] + pngPaths + ["-out", outputPath]
try tiffutil.run()
tiffutil.waitUntilExit()
if tiffutil.terminationStatus != 0 {
  FileHandle.standardError.write(Data("tiffutil failed\n".utf8))
  exit(1)
}
