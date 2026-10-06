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

func checkXObjectDict(_ xobj: CGPDFDictionaryRef, _ hasPhoto: inout Bool) {
    if hasPhoto { return }
    CGPDFDictionaryApplyFunction(xobj, { (k, o, info) in
        guard let info = info else { return }
        var s: CGPDFStreamRef?
        if CGPDFObjectGetValue(o, .stream, &s), let sDict = CGPDFStreamGetDictionary(s!) {
            var subtype: UnsafePointer<CChar>?
            CGPDFDictionaryGetName(sDict, "Subtype", &subtype)
            let subStr = subtype != nil ? String(cString: subtype!) : ""
            
            var filter: UnsafePointer<CChar>?
            CGPDFDictionaryGetName(sDict, "Filter", &filter)
            let fStr = filter != nil ? String(cString: filter!) : ""
            var bpc: CGPDFInteger = 0
            CGPDFDictionaryGetInteger(sDict, "BitsPerComponent", &bpc)
            
            if fStr == "JPXDecode" || fStr == "DCTDecode" || (subStr == "Image" && bpc >= 8) {
                let boolPtr = info.assumingMemoryBound(to: Bool.self)
                boolPtr.pointee = true
                return
            }
            
            // Nếu là Form XObject, duyệt tiếp Resources bên trong
            if subStr == "Form" {
                var formRes: CGPDFDictionaryRef?
                if CGPDFDictionaryGetDictionary(sDict, "Resources", &formRes), let res = formRes {
                    var innerXObj: CGPDFDictionaryRef?
                    if CGPDFDictionaryGetDictionary(res, "XObject", &innerXObj), let inner = innerXObj {
                        checkXObjectDict(inner, &info.assumingMemoryBound(to: Bool.self).pointee)
                    }
                }
            }
        }
    }, &hasPhoto)
}

func pageHasPhotos(page: PDFPage) -> Bool {
    guard let cgPage = page.pageRef, let pageDict = cgPage.dictionary else { return false }
    var resDict: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(pageDict, "Resources", &resDict), let res = resDict else { return false }
    var xobjDict: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(res, "XObject", &xobjDict), let xobj = xobjDict else { return false }
    
    var hasPhoto = false
    checkXObjectDict(xobj, &hasPhoto)
    return hasPhoto
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

    let scale = dpi / 72.0

    // 2. Chạy OCR và trích xuất hình ảnh từng trang trong khoảng yêu cầu
    for p in realStart...realEnd {
        autoreleasepool {
            printJson(ProgressEvent(current: p, total: totalPages))

            guard let page = doc.page(at: p - 1) else { return }
            guard let cgImage = renderPageToCGImage(page: page, scale: scale) else {
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

            // 3. Trích xuất hình ảnh / phụ bản ảnh (Photo plates)
            if let imgDir = imagesDir, pageHasPhotos(page: page) {
                if p == totalPages {
                    // Trang bìa sau (Back cover)
                    let backFileName = "back_cover.jpg"
                    let backDest = "\(imgDir)/\(backFileName)"
                    let backScale: CGFloat = 160.0 / 72.0
                    if let cgImg = renderPageToCGImage(page: page, scale: backScale) {
                        let rep = NSBitmapImageRep(cgImage: cgImg)
                        if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
                            try? data.write(to: URL(fileURLWithPath: backDest))
                            printJson(BackCoverEvent(path: backDest, fileName: backFileName, sizeBytes: data.count))
                        }
                    }
                } else if p > 1 {
                    // Trang ảnh / phụ bản ảnh (Photo plate)
                    let pageRect = page.bounds(for: .mediaBox)
                    // Kiểm tra xem có phải trang bìa tiêu đề mở đầu chương ảnh không (y < 0.85 để loại trừ running header ở mép trên)
                    let isFirstPlate = lines.contains(where: { $0.text.uppercased().contains("KHOẢNH KHẮC") && $0.bbox.y < 0.85 })
                    let topCrop: CGFloat = isFirstPlate ? 20.0 : 75.0
                    let cropRect = CGRect(x: 15, y: 15, width: max(100, pageRect.width - 30), height: max(100, pageRect.height - topCrop))
                    let plateScale: CGFloat = 180.0 / 72.0
                    let width = Int(ceil(cropRect.width * plateScale))
                    let height = Int(ceil(cropRect.height * plateScale))
                    
                    let colorSpace = CGColorSpaceCreateDeviceRGB()
                    if let ctx = CGContext(
                        data: nil,
                        width: width,
                        height: height,
                        bitsPerComponent: 8,
                        bytesPerRow: 0,
                        space: colorSpace,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                    ) {
                        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
                        ctx.saveGState()
                        ctx.scaleBy(x: plateScale, y: plateScale)
                        ctx.translateBy(x: -cropRect.origin.x, y: -cropRect.origin.y)
                        page.draw(with: .mediaBox, to: ctx)
                        ctx.restoreGState()
                        
                        if let plateImage = ctx.makeImage() {
                            let rep = NSBitmapImageRep(cgImage: plateImage)
                            if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
                                let fileName = "photo_p\(p).jpg"
                                let dest = "\(imgDir)/\(fileName)"
                                try? data.write(to: URL(fileURLWithPath: dest))
                                printJson(PageImageEvent(pageNumber: p, fileName: fileName, width: width, height: height, isPhotoPlate: true))
                            }
                        }
                    }
                }
            }

            printJson(PageResult(pageNumber: p, lines: lines))
        }
    }
}

main()
