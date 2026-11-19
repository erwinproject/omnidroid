import sharp from 'sharp';
import type { AiElement, AiSnapshotResponse, InstanceRecord, UiNode } from '@droidforge/shared';
import type { AdbExecutor } from './adb.service.js';
import { flattenUiNodes, type UiAutomationService } from './ui-automation.service.js';

export function extractInteractiveElements(
  tree: UiNode[],
  screenWidth: number,
  screenHeight: number,
): AiElement[] {
  const flat = flattenUiNodes(tree);
  const elements: AiElement[] = [];
  const seenBoxes = new Set<string>();

  for (const node of flat) {
    if (!node.enabled) continue;
    if (node.bounds.width < 8 || node.bounds.height < 8) continue;

    const editable = node.className.toLowerCase().includes('edittext');
    const hasLabel = Boolean(node.text.trim() || node.contentDesc.trim());
    const isInteractive = node.clickable || node.scrollable || editable || node.longClickable || hasLabel;

    if (!isInteractive) continue;

    const boxKey = `${node.bounds.x1},${node.bounds.y1},${node.bounds.x2},${node.bounds.y2}`;
    if (seenBoxes.has(boxKey)) continue;
    seenBoxes.add(boxKey);

    const id = elements.length + 1;
    const label = node.text.trim() || node.contentDesc.trim() || node.resourceId.split('/').pop() || node.className.split('.').pop() || `element_${id}`;

    elements.push({
      id,
      label,
      text: node.text,
      contentDesc: node.contentDesc,
      resourceId: node.resourceId,
      className: node.className,
      clickable: node.clickable,
      scrollable: node.scrollable,
      editable,
      bounds: node.bounds,
      normalizedCenter: {
        x: Number((node.bounds.centerX / Math.max(1, screenWidth)).toFixed(4)),
        y: Number((node.bounds.centerY / Math.max(1, screenHeight)).toFixed(4)),
      },
    });
  }

  return elements;
}

export function buildSetOfMarksSvg(width: number, height: number, elements: AiElement[]): string {
  const overlays = elements
    .map((el) => {
      const { x1, y1, width: w, height: h } = el.bounds;
      const color = el.editable ? '#f59e0b' : el.clickable ? '#10b981' : '#38bdf8';
      const badgeW = el.id >= 10 ? 28 : 22;
      const badgeH = 20;
      const bx = Math.max(0, Math.min(width - badgeW, x1));
      const by = Math.max(0, y1);
      return `
        <rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2" rx="3" />
        <rect x="${bx}" y="${by}" width="${badgeW}" height="${badgeH}" fill="${color}" rx="3" />
        <text x="${bx + badgeW / 2}" y="${by + 14}" fill="#09090b" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="middle">${el.id}</text>
      `;
    })
    .join('\n');

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${overlays}</svg>`;
}

export class AiSnapshotService {
  private readonly elementCache = new Map<string, Map<number, AiElement>>();

  constructor(
    private readonly adb: AdbExecutor,
    private readonly ui: UiAutomationService,
  ) {}

  getCachedElement(instanceId: string, elementId: number): AiElement | undefined {
    return this.elementCache.get(instanceId)?.get(elementId);
  }

  async captureSnapshot(instance: InstanceRecord): Promise<AiSnapshotResponse> {
    const [pngBuffer, hierarchy] = await Promise.all([
      this.adb.screencapPng(instance.adbTarget),
      this.ui.dumpHierarchy(instance),
    ]);

    const meta = await sharp(pngBuffer).metadata();
    const width = meta.width ?? instance.width;
    const height = meta.height ?? instance.height;

    const elements = extractInteractiveElements(hierarchy.tree, width, height);

    const map = new Map<number, AiElement>();
    for (const el of elements) {
      map.set(el.id, el);
    }
    this.elementCache.set(instance.id, map);

    const svg = buildSetOfMarksSvg(width, height, elements);
    const annotated = await sharp(pngBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 82 })
      .toBuffer();

    return {
      instanceId: instance.id,
      capturedAt: new Date().toISOString(),
      screen: { width, height },
      annotatedImageBase64: annotated.toString('base64'),
      mimeType: 'image/jpeg',
      elements,
    };
  }
}
