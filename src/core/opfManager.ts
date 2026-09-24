import * as cheerio from 'cheerio';
import path from 'node:path';
import type { UnpackedEpub } from './epubArchive.js';
import type { EpubManifestItem, EpubMetadata, EpubPackage, EpubSpineItem } from '../types/index.js';

export class OpfManager {
  private unpacked: UnpackedEpub;
  public opfPath: string;
  public opfDir: string;
  private $: cheerio.CheerioAPI;

  constructor(unpacked: UnpackedEpub, opfPath: string) {
    this.unpacked = unpacked;
    this.opfPath = opfPath;
    this.opfDir = path.dirname(opfPath).replace(/\\/g, '/');
    if (this.opfDir === '.') this.opfDir = '';

    const opfXml = unpacked.getFileString(opfPath);
    this.$ = cheerio.load(opfXml, { xmlMode: true });
  }

  static findOpfPath(unpacked: UnpackedEpub): string {
    const containerPath = 'META-INF/container.xml';
    if (!unpacked.hasFile(containerPath)) {
      throw new Error('Không tìm thấy META-INF/container.xml trong file EPUB');
    }
    const containerXml = unpacked.getFileString(containerPath);
    const $ = cheerio.load(containerXml, { xmlMode: true });
    const fullPath = $('rootfile').attr('full-path');
    if (!fullPath) {
      throw new Error('Không tìm thấy thuộc tính full-path trong META-INF/container.xml');
    }
    return fullPath.replace(/\\/g, '/');
  }

  getPackageInfo(): EpubPackage {
    const title = this.$('dc\\:title, title').first().text().trim() || 'Untitled';
    const creator = this.$('dc\\:creator, creator').first().text().trim();
    const language = this.$('dc\\:language, language').first().text().trim() || 'vi';
    const identifier = this.$('dc\\:identifier, identifier').first().text().trim();
    const publisher = this.$('dc\\:publisher, publisher').first().text().trim();

    const metadata: EpubMetadata = { title, creator, language, identifier, publisher };

    const manifest = new Map<string, EpubManifestItem>();
    this.$('manifest > item').each((_, el) => {
      const id = this.$(el).attr('id');
      const href = this.$(el).attr('href');
      const mediaType = this.$(el).attr('media-type');
      const properties = this.$(el).attr('properties');
      if (id && href && mediaType) {
        manifest.set(id, { id, href, mediaType, properties });
      }
    });

    const spine: EpubSpineItem[] = [];
    const spineEl = this.$('spine');
    const tocId = spineEl.attr('toc');

    this.$('spine > itemref').each((_, el) => {
      const idref = this.$(el).attr('idref');
      const linear = this.$(el).attr('linear');
      if (idref) {
        spine.push({ idref, linear });
      }
    });

    let tocHref: string | undefined;
    if (tocId && manifest.has(tocId)) {
      tocHref = manifest.get(tocId)!.href;
    }

    return {
      opfPath: this.opfPath,
      metadata,
      manifest,
      spine,
      tocId,
      tocHref
    };
  }

  /**
   * Chuyển đường dẫn tương đối trong OPF thành đường dẫn đầy đủ trong file zip
   */
  resolvePathInZip(relativeHref: string): string {
    const cleanHref = relativeHref.split('#')[0];
    if (!this.opfDir) return cleanHref;
    return path.posix.join(this.opfDir, cleanHref);
  }

  /**
   * Lấy danh sách tất cả các file HTML/XHTML chương theo đúng thứ tự trong spine
   */
  getSpineChapterFiles(): Array<{ idref: string; zipPath: string; relativeHref: string }> {
    const pkg = this.getPackageInfo();
    const result: Array<{ idref: string; zipPath: string; relativeHref: string }> = [];

    for (const item of pkg.spine) {
      const manifestItem = pkg.manifest.get(item.idref);
      if (manifestItem && (manifestItem.mediaType === 'application/xhtml+xml' || manifestItem.href.endsWith('.html') || manifestItem.href.endsWith('.xhtml'))) {
        result.push({
          idref: item.idref,
          relativeHref: manifestItem.href,
          zipPath: this.resolvePathInZip(manifestItem.href)
        });
      }
    }

    return result;
  }

  /**
   * Đảm bảo manifest có item (ví dụ toc.ncx hoặc nav.xhtml)
   */
  ensureManifestItem(id: string, href: string, mediaType: string, properties?: string): void {
    const existing = this.$(`manifest > item[id="${id}"]`);
    if (existing.length > 0) {
      existing.attr('href', href);
      existing.attr('media-type', mediaType);
      if (properties) existing.attr('properties', properties);
    } else {
      let tag = `<item id="${id}" href="${href}" media-type="${mediaType}"`;
      if (properties) tag += ` properties="${properties}"`;
      tag += '/>';
      this.$('manifest').append(tag);
    }
  }

  /**
   * Đặt thuộc tính toc trong <spine>
   */
  setSpineToc(tocId: string): void {
    this.$('spine').attr('toc', tocId);
  }

  /**
   * Lưu lại nội dung OPF đã cập nhật vào unpacked epub
   */
  save(): void {
    this.unpacked.setFileString(this.opfPath, this.$.xml());
  }
}
