import path from 'node:path';
import { unpackEpub } from '../core/epubArchive.js';
import { OpfManager } from '../core/opfManager.js';
import { ChapterDomProcessor } from '../core/domProcessor.js';
import { selectOrResolveEpub } from '../core/fileSelector.js';

async function main() {
  const query = process.argv[2];
  const selectedEpub = await selectOrResolveEpub(query, { actionName: 'kiểm tra' });
  const epubFile = selectedEpub.fullPath;

  console.log(`\n========================================`);
  console.log(`Kiểm tra cấu trúc EPUB: ${selectedEpub.fileName} (${selectedEpub.sizeFormatted})`);
  console.log(`========================================\n`);

  const unpacked = await unpackEpub(epubFile);
  const opfPath = OpfManager.findOpfPath(unpacked);
  console.log(`- File OPF: ${opfPath}`);

  const opfManager = new OpfManager(unpacked, opfPath);
  const pkg = opfManager.getPackageInfo();
  console.log(`- Tựa đề: ${pkg.metadata.title}`);
  console.log(`- Tác giả: ${pkg.metadata.creator || 'N/A'}`);
  console.log(`- Ngôn ngữ: ${pkg.metadata.language || 'N/A'}`);
  console.log(`- Số lượng file trong manifest: ${pkg.manifest.size}`);
  console.log(`- Số lượng item trong spine: ${pkg.spine.length}`);

  const chapters = opfManager.getSpineChapterFiles();
  console.log(`\n--- Danh sách các file chương (${chapters.length} files) ---`);

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const html = unpacked.getFileString(ch.zipPath);
    const proc = new ChapterDomProcessor(html, ch.relativeHref);
    const topElements = proc.getTopElements(5);
    const paragraphs = proc.indexParagraphs();

    console.log(`\n[${i + 1}/${chapters.length}] ${ch.relativeHref} (Tổng ${paragraphs.length} đoạn văn)`);
    console.log(`   Top elements:`);
    for (const top of topElements) {
      console.log(`     - <${top.tagName}${top.id ? ` id="${top.id}"` : ''}>: "${top.text.slice(0, 80)}"`);
    }
  }
}

main().catch(console.error);
