import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import JSZip from 'jszip';

export interface UnpackedEpub {
  files: Map<string, Buffer>;
  getFileString(filePath: string): string;
  setFileString(filePath: string, content: string): void;
  getFileBuffer(filePath: string): Buffer | undefined;
  setFileBuffer(filePath: string, content: Buffer): void;
  hasFile(filePath: string): boolean;
  listFiles(): string[];
}

/**
 * Giải nén file EPUB vào bộ nhớ
 */
export async function unpackEpub(epubPath: string): Promise<UnpackedEpub> {
  const data = await fs.promises.readFile(epubPath);
  const zip = await JSZip.loadAsync(data);
  const files = new Map<string, Buffer>();

  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir) {
      const buffer = await zipEntry.async('nodebuffer');
      const normalizedPath = relativePath.replace(/\\/g, '/');
      files.set(normalizedPath, buffer);
    }
  }

  return {
    files,
    getFileString(filePath: string): string {
      const buf = files.get(filePath.replace(/\\/g, '/'));
      if (!buf) throw new Error(`File not found in EPUB: ${filePath}`);
      return buf.toString('utf-8');
    },
    setFileString(filePath: string, content: string): void {
      files.set(filePath.replace(/\\/g, '/'), Buffer.from(content, 'utf-8'));
    },
    getFileBuffer(filePath: string): Buffer | undefined {
      return files.get(filePath.replace(/\\/g, '/'));
    },
    setFileBuffer(filePath: string, content: Buffer): void {
      files.set(filePath.replace(/\\/g, '/'), content);
    },
    hasFile(filePath: string): boolean {
      return files.has(filePath.replace(/\\/g, '/'));
    },
    listFiles(): string[] {
      return Array.from(files.keys());
    }
  };
}

export interface SourceEpubMeta {
  sourcePath: string;
  fileName: string;
  baseName: string;
  unpackedAt: string;
}

export function getSourceEpubMeta(targetDir: string): SourceEpubMeta | undefined {
  const metaFile = path.join(targetDir, '.epub-source.json');
  if (fs.existsSync(metaFile)) {
    try {
      return JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as SourceEpubMeta;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Tải một thư mục sách đã giải nén trên đĩa vào interface UnpackedEpub,
 * mọi thay đổi qua setFileString sẽ được ghi trực tiếp xuống file trên đĩa để Git theo dõi diff.
 */
export function loadEpubFromDir(dirPath: string): UnpackedEpub {
  const resolvedDir = path.resolve(dirPath);

  function getAllFiles(dir: string, baseDir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let list: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        list = list.concat(getAllFiles(fullPath, baseDir));
      } else {
        list.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
      }
    }
    return list;
  }

  return {
    files: new Map<string, Buffer>(),
    getFileString(filePath: string): string {
      const fullPath = path.join(resolvedDir, filePath.replace(/\\/g, '/'));
      if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
      return fs.readFileSync(fullPath, 'utf-8');
    },
    setFileString(filePath: string, content: string): void {
      const fullPath = path.join(resolvedDir, filePath.replace(/\\/g, '/'));
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content, 'utf-8');
    },
    getFileBuffer(filePath: string): Buffer | undefined {
      const fullPath = path.join(resolvedDir, filePath.replace(/\\/g, '/'));
      if (!fs.existsSync(fullPath)) return undefined;
      return fs.readFileSync(fullPath);
    },
    setFileBuffer(filePath: string, content: Buffer): void {
      const fullPath = path.join(resolvedDir, filePath.replace(/\\/g, '/'));
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content);
    },
    hasFile(filePath: string): boolean {
      const fullPath = path.join(resolvedDir, filePath.replace(/\\/g, '/'));
      return fs.existsSync(fullPath);
    },
    listFiles(): string[] {
      return getAllFiles(resolvedDir, resolvedDir);
    }
  };
}

/**
 * Giải nén file EPUB ra một thư mục riêng biệt trên đĩa
 * và tự động khởi tạo git commit đầu tiên để người dùng có thể dùng `git diff` so sánh mọi thay đổi của AI.
 */
export async function unpackEpubToDir(
  epubPath: string,
  targetDir: string,
  initGit = true
): Promise<void> {
  if (!fs.existsSync(targetDir)) {
    await fs.promises.mkdir(targetDir, { recursive: true });
  } else {
    // Không xoá chính thư mục targetDir (tránh làm hỏng cwd của terminal đang đứng trong đó)
    // Chỉ dọn dẹp các file con bên trong, giữ lại .git
    const existingEntries = fs.readdirSync(targetDir);
    for (const entry of existingEntries) {
      if (entry === '.git') continue;
      const fullPath = path.join(targetDir, entry);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }

  const data = await fs.promises.readFile(epubPath);
  const zip = await JSZip.loadAsync(data);

  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir) {
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const fullPath = path.join(targetDir, normalizedPath);
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }
      const buffer = await zipEntry.async('nodebuffer');
      await fs.promises.writeFile(fullPath, buffer);
    }
  }

  // Lưu file metadata về sách nguồn để các tool pack, index dễ dàng nhận biết
  const sourceMeta: SourceEpubMeta = {
    sourcePath: path.resolve(epubPath),
    fileName: path.basename(epubPath),
    baseName: path.basename(epubPath, path.extname(epubPath)),
    unpackedAt: new Date().toISOString()
  };
  await fs.promises.writeFile(
    path.join(targetDir, '.epub-source.json'),
    JSON.stringify(sourceMeta, null, 2),
    'utf-8'
  );

  // Khởi tạo git repo riêng trong thư mục giải nén để track diff
  if (initGit) {
    const gitDir = path.join(targetDir, '.git');
    try {
      if (!fs.existsSync(gitDir)) {
        execSync('git init', { cwd: targetDir, stdio: 'ignore' });
        execSync('git config user.name "EPUB Editor"', { cwd: targetDir, stdio: 'ignore' });
        execSync('git config user.email "epub@editor.local"', { cwd: targetDir, stdio: 'ignore' });
      }
      execSync('git add .', { cwd: targetDir, stdio: 'ignore' });
      // Kiểm tra có thay đổi để commit không
      const status = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf-8' });
      if (status.trim()) {
        execSync('git commit -m "Original EPUB content (Bản gốc trước khi AI chỉnh sửa)"', {
          cwd: targetDir,
          stdio: 'ignore'
        });
      }
    } catch {
      // Bỏ qua nếu có lỗi git nhỏ
    }
  }
}

/**
 * Đóng gói thư mục đĩa thành file EPUB chuẩn IDPF:
 * 1. File mimetype nằm đầu tiên, không nén (STORE).
 * 2. Bỏ qua thư mục .git, file ẩn (.DS_Store, .epub-source.json, v.v.).
 * 3. Tất cả các file khác nén DEFLATE.
 */
export async function packEpubFromDir(inputDir: string, outputPath: string): Promise<void> {
  const zip = new JSZip();

  // 1. mimetype bắt buộc đầu tiên và không nén
  const mimetypePath = path.join(inputDir, 'mimetype');
  let mimetypeContent = 'application/epub+zip';
  if (fs.existsSync(mimetypePath)) {
    mimetypeContent = (await fs.promises.readFile(mimetypePath, 'utf-8')).trim();
  }

  zip.file('mimetype', mimetypeContent, {
    compression: 'STORE',
    date: new Date(2020, 0, 1)
  });

  // Đọc đệ quy tất cả các file trong thư mục
  function getAllFiles(dir: string, baseDir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let list: string[] = [];
    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === '.DS_Store' ||
        entry.name === 'mimetype' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        list = list.concat(getAllFiles(fullPath, baseDir));
      } else {
        list.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
      }
    }
    return list;
  }

  const allFiles = getAllFiles(inputDir, inputDir);

  // 2. Thêm META-INF/container.xml trước
  const containerFile = allFiles.find((f) => f.toLowerCase() === 'meta-inf/container.xml');
  if (containerFile) {
    const buf = await fs.promises.readFile(path.join(inputDir, containerFile));
    zip.file(containerFile, buf, { compression: 'DEFLATE' });
  }

  // 3. Thêm tất cả file còn lại
  for (const relPath of allFiles) {
    if (relPath.toLowerCase() === 'meta-inf/container.xml') continue;
    const buf = await fs.promises.readFile(path.join(inputDir, relPath));
    zip.file(relPath, buf, { compression: 'DEFLATE' });
  }

  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip'
  });

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    await fs.promises.mkdir(outDir, { recursive: true });
  }
  await fs.promises.writeFile(outputPath, outputBuffer);
}

/**
 * Đóng gói lại từ đối tượng UnpackedEpub trong bộ nhớ
 */
export async function packEpub(unpacked: UnpackedEpub, outputPath: string): Promise<void> {
  const zip = new JSZip();

  let mimetypeContent = 'application/epub+zip';
  if (unpacked.hasFile('mimetype')) {
    mimetypeContent = unpacked.getFileString('mimetype').trim();
  }

  zip.file('mimetype', mimetypeContent, {
    compression: 'STORE',
    date: new Date(2020, 0, 1)
  });

  const allFiles = unpacked.listFiles().filter((f) => f !== 'mimetype');
  const containerFile = allFiles.find((f) => f.toLowerCase() === 'meta-inf/container.xml');
  if (containerFile) {
    const buf = unpacked.getFileBuffer(containerFile)!;
    zip.file(containerFile, buf, { compression: 'DEFLATE' });
  }

  for (const filePath of allFiles) {
    if (filePath.toLowerCase() === 'meta-inf/container.xml') continue;
    const buf = unpacked.getFileBuffer(filePath)!;
    zip.file(filePath, buf, { compression: 'DEFLATE' });
  }

  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip'
  });

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    await fs.promises.mkdir(outDir, { recursive: true });
  }

  await fs.promises.writeFile(outputPath, outputBuffer);
}

