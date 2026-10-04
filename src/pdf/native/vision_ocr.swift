import Foundation
import PDFKit
import Vision
import AppKit

struct BBox: Codable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

struct LineItem: Codable {
    let text: String
    let bbox: BBox
    let confidence: Double
}

struct PageResult: Codable {
    let type: String = "page"
    let pageNumber: Int
    let lines: [LineItem]
}

struct ProgressEvent: Codable {
    let type: String = "progress"
    let current: Int
    let total: Int
}

struct CoverEvent: Codable {
    let type: String = "cover"
    let path: String
    let sizeBytes: Int
}

struct ErrorEvent: Codable {
    let type: String = "error"
    let message: String
}

func printJson<T: Codable>(_ value: T) {
    if let data = try? JSONEncoder().encode(value),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func main() {
    let args = CommandLine.arguments
    if args.count < 2 {
        printJson(ErrorEvent(message: "Usage: vision_ocr <pdf-path> [--start-page <N>] [--end-page <N>] [--extract-cover <path>] [--langs <vi-VT,en-US>] [--dpi <150|200|300>]"))
        exit(1)
    }

    let pdfPath = args[1]
    var startPage = 1
    var endPage = Int.max
    var coverPath: String? = nil
    var langs = ["vi-VT", "en-US"]
    var dpi: CGFloat = 200.0

    var i = 2
    while i < args.count {
        switch args[i] {
        case "--start-page":
            if i + 1 < args.count, let val = Int(args[i + 1]) {
                startPage = val
                i += 1
            }
        case "--end-page":
            if i + 1 < args.count, let val = Int(args[i + 1]) {
                endPage = val
                i += 1
            }
        case "--extract-cover":
            if i + 1 < args.count {
                coverPath = args[i + 1]
                i += 1
            }
        case "--langs":
            if i + 1 < args.count {
                langs = args[i + 1].split(separator: ",").map { String($0) }
                i += 1
            }
        case "--dpi":
            if i + 1 < args.count, let val = Double(args[i + 1]) {
                dpi = CGFloat(val)
                i += 1
            }
        default:
            break
        }
        i += 1
    }

    let fileUrl = URL(fileURLWithPath: pdfPath)
    guard let doc = PDFDocument(url: fileUrl) else {
        printJson(ErrorEvent(message: "Cannot open PDF document at: \(pdfPath)"))
        exit(1)
    }

    let totalPages = doc.pageCount
    let realStart = max(1, min(startPage, totalPages))
    let realEnd = max(realStart, min(endPage, totalPages))

    // 1. Tách ảnh bìa nếu được yêu cầu
    if let coverDest = coverPath, let firstPage = doc.page(at: 0) {
        let pageRect = firstPage.bounds(for: .mediaBox)
        let scale = 200.0 / 72.0
        let targetSize = NSSize(width: pageRect.width * scale, height: pageRect.height * scale)
        let img = NSImage(size: targetSize, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.scaleBy(x: scale, y: scale)
            firstPage.draw(with: .mediaBox, to: ctx)
            return true
        }
        if let tiff = img.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let jpgData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) {
            let destUrl = URL(fileURLWithPath: coverDest)
            try? FileManager.default.createDirectory(at: destUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? jpgData.write(to: destUrl)
            printJson(CoverEvent(path: coverDest, sizeBytes: jpgData.count))
        }
    }

    let scale = dpi / 72.0

    // 2. Chạy OCR từng trang trong khoảng yêu cầu
    for p in realStart...realEnd {
        printJson(ProgressEvent(current: p, total: totalPages))

        guard let page = doc.page(at: p - 1) else { continue }
        let pageRect = page.bounds(for: .mediaBox)
        let targetSize = NSSize(width: pageRect.width * scale, height: pageRect.height * scale)

        let img = NSImage(size: targetSize, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.scaleBy(x: scale, y: scale)
            page.draw(with: .mediaBox, to: ctx)
            return true
        }

        guard let tiff = img.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let cgImage = bitmap.cgImage else {
            printJson(PageResult(pageNumber: p, lines: []))
            continue
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = langs
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            printJson(PageResult(pageNumber: p, lines: []))
            continue
        }

        guard let observations = request.results else {
            printJson(PageResult(pageNumber: p, lines: []))
            continue
        }

        var lines: [LineItem] = []
        for obs in observations {
            if let cand = obs.topCandidates(1).first {
                let text = cand.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    let box = BBox(
                        x: Double(obs.boundingBox.origin.x),
                        y: Double(obs.boundingBox.origin.y),
                        w: Double(obs.boundingBox.size.width),
                        h: Double(obs.boundingBox.size.height)
                    )
                    lines.append(LineItem(text: text, bbox: box, confidence: Double(cand.confidence)))
                }
            }
        }

        // Sắp xếp các dòng theo thứ tự từ trên xuống dưới (y giảm dần)
        lines.sort { a, b in
            // Nếu cùng một dòng (chênh lệch y rất nhỏ < 0.015), sắp xếp theo x từ trái sang phải
            if abs(a.bbox.y - b.bbox.y) < 0.012 {
                return a.bbox.x < b.bbox.x
            }
            return a.bbox.y > b.bbox.y
        }

        printJson(PageResult(pageNumber: p, lines: lines))
    }
}

main()
