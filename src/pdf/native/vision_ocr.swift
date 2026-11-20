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

struct BackCoverEvent: Codable {
    let type: String = "back_cover"
    let path: String
    let fileName: String
    let sizeBytes: Int
}

struct PageImageEvent: Codable {
    let type: String = "page_image"
    let pageNumber: Int
    let fileName: String
    let width: Int
    let height: Int
    let isPhotoPlate: Bool
    let bbox: BBox
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

/// Phát hiện các vùng ảnh minh hoạ trên trang (kể cả khi cả trang là một ảnh scan).
/// Ý tưởng: vùng có "mực" nhưng KHÔNG nằm trong dòng chữ OCR tin cậy, gom lại thành cụm lớn và đặc.
/// Trả về bbox chuẩn hoá theo hệ Vision (gốc dưới-trái, y hướng lên).
func detectIllustrations(cgImage: CGImage, lines: [LineItem]) -> [BBox] {
    let lw = 480
    let lh = max(1, Int((Double(lw) * Double(cgImage.height) / Double(cgImage.width)).rounded()))
    guard let ctx = CGContext(
        data: nil, width: lw, height: lh, bitsPerComponent: 8, bytesPerRow: lw,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return [] }
    ctx.interpolationQuality = .medium
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: lw, height: lh))
    guard let raw = ctx.data else { return [] }
    let px = raw.bindMemory(to: UInt8.self, capacity: lw * lh)

    var ink = [Bool](repeating: false, count: lw * lh)
    for i in 0..<(lw * lh) { ink[i] = px[i] < 215 }

    // Xoá mực thuộc các dòng chữ OCR tin cậy
    for l in lines where l.confidence >= 0.4 {
        let padX = 0.004, padY = 0.003
        let x0 = max(0, Int((l.bbox.x - padX) * Double(lw)))
        let x1 = min(lw - 1, Int((l.bbox.x + l.bbox.w + padX) * Double(lw)))
        let y0 = max(0, Int((1.0 - (l.bbox.y + l.bbox.h + padY)) * Double(lh)))
        let y1 = min(lh - 1, Int((1.0 - (l.bbox.y - padY)) * Double(lh)))
        if x0 > x1 || y0 > y1 { continue }
        for yy in y0...y1 { for xx in x0...x1 { ink[yy * lw + xx] = false } }
    }

    // Lưới ô 6px: ô "có mực" nếu >= 10% điểm ảnh là mực; bỏ lề 2% (bóng viền scan)
    let cs = 6
    let gw = lw / cs, gh = lh / cs
    let mx = max(1, Int(Double(gw) * 0.02)), my = max(1, Int(Double(gh) * 0.02))
    var cell = [Bool](repeating: false, count: gw * gh)
    for gy in my..<(gh - my) {
        for gx in mx..<(gw - mx) {
            var c = 0
            for yy in 0..<cs { for xx in 0..<cs where ink[(gy * cs + yy) * lw + gx * cs + xx] { c += 1 } }
            cell[gy * gw + gx] = Double(c) / Double(cs * cs) >= 0.10
        }
    }

    // Giãn 1 ô để nối các mảng gần nhau, rồi gán nhãn thành phần liên thông (8 hướng)
    var dil = cell
    for gy in 0..<gh { for gx in 0..<gw where cell[gy * gw + gx] {
        for dy in -1...1 { for dx in -1...1 {
            let ny = gy + dy, nx = gx + dx
            if ny >= 0 && ny < gh && nx >= 0 && nx < gw { dil[ny * gw + nx] = true }
        } }
    } }

    var visited = [Bool](repeating: false, count: gw * gh)
    var result: [BBox] = []
    for start in 0..<(gw * gh) where dil[start] && !visited[start] {
        var stack = [start]
        visited[start] = true
        var minX = gw, maxX = 0, minY = gh, maxY = 0, inkCells = 0
        while let cur = stack.popLast() {
            let cx = cur % gw, cy = cur / gw
            minX = min(minX, cx); maxX = max(maxX, cx); minY = min(minY, cy); maxY = max(maxY, cy)
            if cell[cur] { inkCells += 1 }
            for dy in -1...1 { for dx in -1...1 {
                let ny = cy + dy, nx = cx + dx
                if ny >= 0 && ny < gh && nx >= 0 && nx < gw {
                    let ni = ny * gw + nx
                    if dil[ni] && !visited[ni] { visited[ni] = true; stack.append(ni) }
                }
            } }
        }
        let bw = maxX - minX + 1, bh = maxY - minY + 1
        let wFrac = Double(bw) / Double(gw), hFrac = Double(bh) / Double(gh)
        let density = Double(inkCells) / Double(bw * bh)
        if wFrac >= 0.18 && hFrac >= 0.05 && wFrac * hFrac >= 0.03 && density >= 0.35 {
            // Bỏ giãn 1 ô (đã nới ở trên) rồi đổi sang toạ độ Vision
            let x0 = Double(max(0, minX)) / Double(gw)
            let x1 = Double(min(gw, maxX + 1)) / Double(gw)
            let yTop = Double(max(0, minY)) / Double(gh)
            let yBot = Double(min(gh, maxY + 1)) / Double(gh)
            result.append(BBox(x: x0, y: 1.0 - yBot, w: x1 - x0, h: yBot - yTop))
        }
    }
    // Sắp xếp từ trên xuống dưới
    result.sort { ($0.y + $0.h) > ($1.y + $1.h) }
    return result
}

func main() {
    let args = CommandLine.arguments
    if args.count < 2 {
        printJson(ErrorEvent(message: "Usage: vision_ocr <pdf-path> [--start-page <N>] [--end-page <N>] [--extract-cover <path>] [--extract-images <dir>] [--langs <vi-VT,en-US>] [--dpi <150|200|300>]"))
        exit(1)
    }

    let pdfPath = args[1]
    var startPage = 1
    var endPage = Int.max
    var coverPath: String? = nil
    var imagesDir: String? = nil
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
        case "--extract-images":
            if i + 1 < args.count {
                imagesDir = args[i + 1]
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

    if let imgDir = imagesDir {
        try? FileManager.default.createDirectory(atPath: imgDir, withIntermediateDirectories: true)
    }

    // Hàm render trực tiếp PDFPage sang CGImage qua CGContext
    func renderPageToCGImage(page: PDFPage, scale: CGFloat) -> CGImage? {
        let pageRect = page.bounds(for: .mediaBox)
        let width = Int(ceil(pageRect.width * scale))
        let height = Int(ceil(pageRect.height * scale))
        guard width > 0 && height > 0 else { return nil }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return nil }

        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))

        context.saveGState()
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -pageRect.origin.x, y: -pageRect.origin.y)
        page.draw(with: .mediaBox, to: context)
        context.restoreGState()

        return context.makeImage()
    }

    // 1. Tách ảnh bìa nếu được yêu cầu
    if let coverDest = coverPath, let firstPage = doc.page(at: 0) {
        autoreleasepool {
            let coverScale = 200.0 / 72.0
            if let cgImage = renderPageToCGImage(page: firstPage, scale: coverScale) {
                let bitmap = NSBitmapImageRep(cgImage: cgImage)
                if let jpgData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) {
                    let destUrl = URL(fileURLWithPath: coverDest)
                    try? FileManager.default.createDirectory(at: destUrl.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? jpgData.write(to: destUrl)
                    printJson(CoverEvent(path: coverDest, sizeBytes: jpgData.count))
                }
            }
        }
    }

    let baseScale = dpi / 72.0
    // Giới hạn bề rộng bitmap ~2200px: PDF scan có mediabox lớn (vd 1500pt) thì dpi cao chỉ tốn thời gian
    func effectiveScale(_ page: PDFPage) -> CGFloat {
        let w = page.bounds(for: .mediaBox).width
        return w > 0 ? min(baseScale, 2200.0 / w) : baseScale
    }

    // 2. Chạy OCR và trích xuất hình ảnh từng trang trong khoảng yêu cầu
    for p in realStart...realEnd {
        autoreleasepool {
            printJson(ProgressEvent(current: p, total: totalPages))

            guard let page = doc.page(at: p - 1) else { return }
            guard let cgImage = renderPageToCGImage(page: page, scale: effectiveScale(page)) else {
                printJson(PageResult(pageNumber: p, lines: []))
                return
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
                return
            }

            guard let observations = request.results else {
                printJson(PageResult(pageNumber: p, lines: []))
                return
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
                if abs(a.bbox.y - b.bbox.y) < 0.012 {
                    return a.bbox.x < b.bbox.x
                }
                return a.bbox.y > b.bbox.y
            }

            // 3. Phát hiện & cắt ảnh minh hoạ xen kẽ (bỏ trang 1 vì đã xử lý như bìa)
            if let imgDir = imagesDir, p > 1 {
                let regions = detectIllustrations(cgImage: cgImage, lines: lines)
                let W = Double(cgImage.width), H = Double(cgImage.height)
                var kept: [(BBox, Int)] = []
                for (idx, r) in regions.enumerated() {
                    // Nới biên 1% để không cắt sát
                    let nx = max(0.0, r.x - 0.01), ny = max(0.0, r.y - 0.01)
                    let nw = min(1.0 - nx, r.w + 0.02), nh = min(1.0 - ny, r.h + 0.02)
                    let cropRect = CGRect(x: nx * W, y: (1.0 - (ny + nh)) * H, width: nw * W, height: nh * H).integral
                    guard let sub = cgImage.cropping(to: cropRect) else { continue }
                    let rep = NSBitmapImageRep(cgImage: sub)
                    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { continue }

                    let isBackCover = (p == totalPages && r.w * r.h >= 0.5)
                    if isBackCover {
                        let backFileName = "back_cover.jpg"
                        let backDest = "\(imgDir)/\(backFileName)"
                        try? data.write(to: URL(fileURLWithPath: backDest))
                        printJson(BackCoverEvent(path: backDest, fileName: backFileName, sizeBytes: data.count))
                        continue
                    }
                    let fileName = "photo_p\(p)_\(idx + 1).jpg"
                    try? data.write(to: URL(fileURLWithPath: "\(imgDir)/\(fileName)"))
                    let box = BBox(x: nx, y: ny, w: nw, h: nh)
                    kept.append((box, idx))
                    printJson(PageImageEvent(pageNumber: p, fileName: fileName, width: sub.width, height: sub.height, isPhotoPlate: false, bbox: box))
                }
                // Bỏ các dòng OCR nằm trong vùng ảnh (chữ trên biển/áp phích trong ảnh) để khỏi lẫn vào thân bài
                if !kept.isEmpty {
                    lines = lines.filter { l in
                        let cx = l.bbox.x + l.bbox.w / 2, cy = l.bbox.y + l.bbox.h / 2
                        return !kept.contains { k in
                            cx >= k.0.x && cx <= k.0.x + k.0.w && cy >= k.0.y && cy <= k.0.y + k.0.h
                        }
                    }
                }
            }

            printJson(PageResult(pageNumber: p, lines: lines))
        }
    }
}

main()
