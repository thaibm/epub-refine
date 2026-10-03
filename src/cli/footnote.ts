import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command } from 'commander';
import { loadEpubFromDir, unpackEpubToDir, getSourceEpubMeta } from '../core/epubArchive.js';
import { selectOrResolveEpub } from '../core/fileSelector.js';
import { FootnoteProcessor } from '../core/footnoteProcessor.js';

const program = new Command();

program
  .name('footnote')
  .description('Quản lý, kiểm định tính toàn vẹn, sửa lỗi và chuẩn hoá chú thích (Footnotes / Endnotes) trong EPUB')
  .option('-i, --input <query>', 'Số thứ tự [1-N], tên file hoặc từ khoá file EPUB trong input/')
  .option('-d, --dir <path>', 'Thư mục làm việc giải nén (có Git tracking)', './workspace')
  .option('--all', 'Chạy tự động nâng cấp Pop-up EPUB 3 và sửa liên kết gãy', false)
  .option('--fix', 'Tự động sửa các liên kết chú thích bị gãy và khôi phục anchor ID', false)
  .option('--popup', 'Nâng cấp sang chuẩn EPUB 3 Pop-up footnote (Kindle, Apple Books, Kobo)', false)
  .option('--renumber [style]', 'Đánh số lại thứ tự chú thích liên tục: "bracket" ([1], [2]), "star" ([*]), "number" (1, 2)')
  .option('--check', 'Chỉ quét kiểm tra và in báo cáo, không thay đổi file', false)
  .option('--fresh', 'Bắt buộc giải nén lại từ file EPUB gốc (ghi đè workspace)', false);

program.parse(process.argv);
const options = program.opts();

async function main() {
  let workspaceDir: string;
  if (fs.existsSync(path.join(process.cwd(), 'mimetype')) && fs.existsSync(path.join(process.cwd(), 'META-INF'))) {
    workspaceDir = process.cwd();
  } else {
    workspaceDir = path.resolve(options.dir);
  }

  const isAlreadyUnpacked =
    fs.existsSync(path.join(workspaceDir, 'mimetype')) &&
    fs.existsSync(path.join(workspaceDir, 'META-INF'));

  const existingMeta = isAlreadyUnpacked ? getSourceEpubMeta(workspaceDir) : undefined;

  if (options.input) {
    const selected = await selectOrResolveEpub(options.input, { actionName: 'kiểm tra chú thích' });
    const sameBook = isAlreadyUnpacked && existingMeta?.fileName === selected.fileName;

    if (!isAlreadyUnpacked || options.fresh || !sameBook) {
      console.log(`📦 Đang giải nén EPUB "${selected.fileName}" vào "${workspaceDir}"...`);
      await unpackEpubToDir(selected.fullPath, workspaceDir, true);
    }
  } else if (!isAlreadyUnpacked || options.fresh) {
    const selected = await selectOrResolveEpub(undefined, { actionName: 'kiểm tra chú thích' });
    console.log(`📦 Đang giải nén EPUB "${selected.fileName}" vào "${workspaceDir}"...`);
    await unpackEpubToDir(selected.fullPath, workspaceDir, true);
  }

  console.log(`\n======================================================`);
  console.log(`🔖 QUẢN LÝ & CHUẨN HOÁ CHÚ THÍCH (FOOTNOTE PROCESSOR)`);
  console.log(`📁 Thư mục: ${workspaceDir}`);
  if (existingMeta?.fileName) {
    console.log(`📖 Sách: "${existingMeta.fileName}"`);
  }
  console.log(`======================================================\n`);

  const unpacked = loadEpubFromDir(workspaceDir);

  // 1. Quét và kiểm định toàn bộ sách
  const initialReport = FootnoteProcessor.validate(unpacked);

  console.log(`📊 TÌNH TRẠNG CHÚ THÍCH HIỆN TẠI:`);
  console.log(`   - Vị trí gọi chú thích trong bài (Refs): ${initialReport.totalRefs}`);
  console.log(`   - Định nghĩa nội dung chú thích (Defs):  ${initialReport.totalDefs}`);
  console.log(`   - Cặp liên kết 2 chiều hợp lệ:          ${initialReport.validPairs}`);
  if (initialReport.unlinkedPlaintextCount > 0) {
    console.log(`   - Chú thích dạng text thuần ([1], [2]...): ${initialReport.unlinkedPlaintextCount} (ở cuối các chương, chưa gắn thẻ liên kết)`);
  }
  console.log(`   - File chú thích:                       ${initialReport.footnoteFiles.length > 0 ? initialReport.footnoteFiles.join(', ') : 'Không có (hoặc dùng inline note)'}`);
  console.log(`   - Chuẩn EPUB 3 Pop-up:                  ${initialReport.isEpub3PopupReady ? '✅ Đã kích hoạt (Pop-up Card)' : '⚠️ Chưa tối ưu (chuyển trang thường hoặc text thuần)'}`);

  if (initialReport.issues.length > 0) {
    console.log(`\n⚠️ PHÁT HIỆN ${initialReport.issues.length} VẤN ĐỀ CHÚ THÍCH:`);
    for (const issue of initialReport.issues) {
      let icon = '❌';
      if (issue.type === 'orphan_def' || issue.type === 'orphan_ref' || issue.type === 'unlinked_plaintext') icon = '🔸';
      console.log(`   ${icon} [${issue.type.toUpperCase()}] (${issue.file}): ${issue.message}`);
    }
  } else if (initialReport.totalRefs > 0 || initialReport.totalDefs > 0) {
    console.log(`\n✅ Tất cả các liên kết chú thích đều toàn vẹn (không có link gãy).`);
  }

  // Nếu sách không có chú thích nào (cả liên kết lẫn text thuần)
  if (initialReport.totalRefs === 0 && initialReport.totalDefs === 0 && initialReport.unlinkedPlaintextCount === 0) {
    console.log(`\nℹ️ Sách này không chứa chú thích nào (Footnotes/Endnotes). Không cần xử lý thêm.\n`);
    return;
  }

  // Xác định xem có tham số dòng lệnh trực tiếp không
  const hasDirectFlag = options.all || options.fix || options.popup || options.renumber !== undefined || options.check;

  let selectedChoice = '1';

  if (!hasDirectFlag) {
    console.log(`\n======================================================`);
    console.log(`👉 BẠN MUỐN THỰC HIỆN HÀNH ĐỘNG GÌ?`);
    console.log(`   [1] ✨ Toàn diện: Liên kết hoá text thuần + Nâng cấp Pop-up EPUB 3 + Sửa lỗi link (Khuyến nghị)`);
    console.log(`   [2] 🚀 Nâng cấp Pop-up EPUB 3 & Liên kết hoá chú thích (Kindle / Apple Books / Kobo)`);
    console.log(`   [3] 🔧 Tự động sửa liên kết bị gãy & khôi phục anchor ID`);
    console.log(`   [4] 🔢 Đánh số lại thứ tự chú thích liên tục ([1], [2], [3]...)`);
    console.log(`   [5] 🔍 Chỉ kiểm tra, giữ nguyên file`);
    console.log(`======================================================`);

    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`👉 Nhập lựa chọn [1-5] (mặc định: 1): `);
      selectedChoice = answer.trim() || '1';
    } finally {
      rl.close();
    }
  }

  // Thực hiện theo lựa chọn hoặc cờ CLI
  let doFix = options.all || options.fix || selectedChoice === '1' || selectedChoice === '3';
  let doPopup = options.all || options.popup || selectedChoice === '1' || selectedChoice === '2';
  let doRenumber = options.renumber !== undefined || selectedChoice === '4';
  let doCheckOnly = options.check || selectedChoice === '5';

  if (doCheckOnly && !options.all && !options.fix && !options.popup && options.renumber === undefined) {
    console.log(`\n🔍 Đã hoàn tất kiểm tra. Không có thay đổi nào được thực hiện.`);
    return;
  }

  let modified = false;

  // 1. Tự động liên kết hoá các chú thích text thuần nếu có
  if (doFix || doPopup) {
    const plainScan = FootnoteProcessor.scanPlaintextFootnotes(unpacked);
    if (plainScan.totalPlaintextNotes > 0) {
      console.log(`\n🔗 Đang tự động liên kết hoá ${plainScan.totalPlaintextNotes} chú thích text thuần ở cuối các chương...`);
      const convertRes = FootnoteProcessor.convertPlaintextFootnotes(unpacked);
      console.log(`   ✅ Đã chuyển đổi ${convertRes.totalConverted} mục chú thích thành thẻ Pop-up EPUB 3 liên kết 2 chiều.`);
      modified = true;
    }
  }

  // 2. Tự động sửa lỗi liên kết
  if (doFix) {
    console.log(`\n🔧 Đang tự động kiểm tra và sửa liên kết...`);
    const repairResult = FootnoteProcessor.autoRepair(unpacked);
    if (repairResult.repairedCount > 0) {
      console.log(`   ✅ Đã sửa và cập nhật: ${repairResult.repairedCount} liên kết.`);
      modified = true;
    } else {
      console.log(`   ✅ Tất cả liên kết đã chính xác, không cần sửa đổi thêm.`);
    }
  }

  // 2. Đánh số lại thứ tự
  if (doRenumber) {
    let renumberStyle: 'bracket-number' | 'star' | 'number' = 'bracket-number';
    if (typeof options.renumber === 'string') {
      if (options.renumber === 'star') renumberStyle = 'star';
      else if (options.renumber === 'number') renumberStyle = 'number';
    } else if (selectedChoice === '4') {
      console.log(`\n   Chọn kiểu đánh số:`);
      console.log(`     [1] Dạng số trong ngoặc: [1], [2], [3]... (mặc định)`);
      console.log(`     [2] Dạng hoa thị: [*]`);
      console.log(`     [3] Dạng số trần: 1, 2, 3...`);
      const rlSub = readline.createInterface({ input: stdin, output: stdout });
      try {
        const subAns = (await rlSub.question(`   👉 Chọn [1-3] (mặc định: 1): `)).trim();
        if (subAns === '2') renumberStyle = 'star';
        else if (subAns === '3') renumberStyle = 'number';
      } finally {
        rlSub.close();
      }
    }

    console.log(`\n🔢 Đang đánh số lại thứ tự chú thích (kiểu: ${renumberStyle})...`);
    const renumResult = FootnoteProcessor.renumberFootnotes(unpacked, renumberStyle);
    console.log(`   ✅ Đã đánh số lại ${renumResult.totalRenumbered} liên kết chú thích.`);
    modified = true;
  }

  // 3. Nâng cấp EPUB 3 Pop-up
  if (doPopup) {
    console.log(`\n🚀 Đang nâng cấp chú thích sang chuẩn EPUB 3 Pop-up...`);
    const popupResult = FootnoteProcessor.convertToEpub3Popup(unpacked);
    console.log(`   ✅ Đã gắn epub:type="noteref" cho ${popupResult.convertedRefs} vị trí gọi chú thích.`);
    console.log(`   ✅ Đã gắn epub:type="footnote" cho ${popupResult.convertedDefs} định nghĩa chú thích.`);
    modified = true;
  }

  if (modified) {
    console.log(`\n======================================================`);
    console.log(`🎉 HOÀN TẤT CẬP NHẬT CHÚ THÍCH!`);
    const finalReport = FootnoteProcessor.validate(unpacked);
    console.log(`   - Cặp liên kết hợp lệ:      ${finalReport.validPairs}`);
    console.log(`   - Số lỗi còn lại:           ${finalReport.issues.length}`);
    console.log(`   - Chuẩn EPUB 3 Pop-up ready: ${finalReport.isEpub3PopupReady ? '✅ Đã kích hoạt' : 'Chưa'}`);
    console.log(`======================================================\n`);
    console.log(`💡 Bạn có thể kiểm tra chi tiết các thay đổi bằng lệnh:`);
    console.log(`   git -C "${workspaceDir}" diff\n`);
  }
}

main().catch((err) => {
  console.error('❌ Lỗi không mong muốn:', err);
  process.exit(1);
});
