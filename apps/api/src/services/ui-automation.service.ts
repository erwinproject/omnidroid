import { XMLParser } from 'fast-xml-parser';
import type {
  InstanceRecord,
  UiBatchActionsInput,
  UiBounds,
  UiNode,
  UiSelector,
  UiWaitInput,
} from '@droidforge/shared';
import type { AdbExecutor } from './adb.service.js';
import type { InputService } from './input.service.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
});

export function parseBoundsString(boundsStr: string): UiBounds {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) {
    return { x1: 0, y1: 0, x2: 0, y2: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  }
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return {
    x1,
    y1,
    x2,
    y2,
    width,
    height,
    centerX: Math.round(x1 + width / 2),
    centerY: Math.round(y1 + height / 2),
  };
}

function normalizeRawNode(raw: Record<string, unknown>): UiNode {
  const childRaw = raw.node;
  const childrenArr = Array.isArray(childRaw) ? childRaw : childRaw ? [childRaw] : [];

  return {
    index: Number(raw['@_index'] ?? 0),
    text: String(raw['@_text'] ?? ''),
    resourceId: String(raw['@_resource-id'] ?? ''),
    className: String(raw['@_class'] ?? ''),
    packageName: String(raw['@_package'] ?? ''),
    contentDesc: String(raw['@_content-desc'] ?? ''),
    checkable: raw['@_checkable'] === 'true',
    checked: raw['@_checked'] === 'true',
    clickable: raw['@_clickable'] === 'true',
    enabled: raw['@_enabled'] !== 'false',
    focusable: raw['@_focusable'] === 'true',
    focused: raw['@_focused'] === 'true',
    scrollable: raw['@_scrollable'] === 'true',
    longClickable: raw['@_long-clickable'] === 'true',
    password: raw['@_password'] === 'true',
    selected: raw['@_selected'] === 'true',
    bounds: parseBoundsString(String(raw['@_bounds'] ?? '[0,0][0,0]')),
    children: childrenArr.map((c) => normalizeRawNode(c as Record<string, unknown>)),
  };
}

export function parseUiHierarchyXml(xml: string): UiNode[] {
  const xmlStart = xml.indexOf('<?xml');
  const cleanXml = xmlStart >= 0 ? xml.slice(xmlStart) : xml;
  const parsed = xmlParser.parse(cleanXml) as { hierarchy?: { node?: unknown } };
  const rootNodes = parsed.hierarchy?.node;
  if (!rootNodes) return [];
  const arr = Array.isArray(rootNodes) ? rootNodes : [rootNodes];
  return arr.map((n) => normalizeRawNode(n as Record<string, unknown>));
}

export function flattenUiNodes(nodes: UiNode[]): UiNode[] {
  const out: UiNode[] = [];
  const walk = (list: UiNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function matchSelector(nodes: UiNode[], selector: UiSelector): UiNode[] {
  const flat = flattenUiNodes(nodes);
  const matched = flat.filter((n) => {
    if (selector.text !== undefined && n.text !== selector.text) return false;
    if (selector.textContains !== undefined && !n.text.toLowerCase().includes(selector.textContains.toLowerCase())) {
      return false;
    }
    if (selector.resourceId !== undefined && !n.resourceId.includes(selector.resourceId)) return false;
    if (selector.contentDesc !== undefined && !n.contentDesc.toLowerCase().includes(selector.contentDesc.toLowerCase())) {
      return false;
    }
    if (selector.className !== undefined && !n.className.includes(selector.className)) return false;
    if (selector.clickable !== undefined && n.clickable !== selector.clickable) return false;
    if (selector.scrollable !== undefined && n.scrollable !== selector.scrollable) return false;
    return true;
  });

  if (selector.index !== undefined) {
    return matched[selector.index] ? [matched[selector.index]] : [];
  }
  return matched;
}

export class UiAutomationService {
  constructor(
    private readonly adb: AdbExecutor,
    private readonly input: InputService,
  ) {}

  async dumpHierarchy(instance: InstanceRecord): Promise<{ xml: string; tree: UiNode[] }> {
    // Dump to /sdcard/window_dump.xml then cat (more reliable across Android 11-14 than /dev/tty)
    const tmpPath = '/data/local/tmp/droidforge_ui.xml';
    await this.adb.shell(instance.adbTarget, `uiautomator dump ${tmpPath}`, 15000);
    const res = await this.adb.shell(instance.adbTarget, `cat ${tmpPath}`, 10000);
    if (res.exitCode !== 0 || !res.stdout.includes('<hierarchy')) {
      throw new Error(`Failed to dump UI hierarchy: ${res.stderr || res.stdout}`);
    }
    const tree = parseUiHierarchyXml(res.stdout);
    return { xml: res.stdout, tree };
  }

  async find(instance: InstanceRecord, selector: UiSelector): Promise<UiNode[]> {
    const { tree } = await this.dumpHierarchy(instance);
    return matchSelector(tree, selector);
  }

  async waitFor(
    instance: InstanceRecord,
    input: UiWaitInput,
  ): Promise<{ matched: boolean; elapsedMs: number; node?: UiNode }> {
    const start = Date.now();
    while (Date.now() - start <= input.timeoutMs) {
      try {
        const nodes = await this.find(instance, input.selector);
        if (input.state === 'visible' && nodes.length > 0) {
          return { matched: true, elapsedMs: Date.now() - start, node: nodes[0] };
        }
        if (input.state === 'gone' && nodes.length === 0) {
          return { matched: true, elapsedMs: Date.now() - start };
        }
      } catch {
        // Retry on transient uiautomator error
      }
      await new Promise((r) => setTimeout(r, input.intervalMs));
    }
    return { matched: false, elapsedMs: Date.now() - start };
  }

  async executeBatch(
    instance: InstanceRecord,
    input: UiBatchActionsInput,
    resolveElementClick: (instanceId: string, elementId: number) => { x: number; y: number } | undefined,
  ): Promise<{ ok: boolean; results: Array<{ step: number; action: string; ok: boolean; detail?: string }> }> {
    const results: Array<{ step: number; action: string; ok: boolean; detail?: string }> = [];

    for (let i = 0; i < input.steps.length; i++) {
      const step = input.steps[i];
      try {
        switch (step.action) {
          case 'launch': {
            await this.adb.shell(
              instance.adbTarget,
              `monkey -p ${step.packageName} -c android.intent.category.LAUNCHER 1`,
            );
            break;
          }
          case 'wait': {
            const w = await this.waitFor(instance, {
              selector: step.selector,
              state: 'visible',
              timeoutMs: step.timeoutMs ?? 10000,
              intervalMs: 400,
            });
            if (!w.matched) throw new Error('Timed out waiting for selector');
            break;
          }
          case 'click': {
            if (step.elementId !== undefined) {
              const pt = resolveElementClick(instance.id, step.elementId);
              if (!pt) throw new Error(`Element #${step.elementId} not found in latest AI snapshot`);
              await this.input.tap(instance, { x: pt.x, y: pt.y, normalized: false });
            } else if (step.selector) {
              const nodes = await this.find(instance, step.selector);
              if (nodes.length === 0) throw new Error('Selector matched 0 nodes');
              await this.input.tap(instance, {
                x: nodes[0].bounds.centerX,
                y: nodes[0].bounds.centerY,
                normalized: false,
              });
            } else {
              throw new Error('click requires either elementId or selector');
            }
            break;
          }
          case 'tap':
            await this.input.tap(instance, { x: step.x, y: step.y, normalized: step.normalized ?? false });
            break;
          case 'swipe':
            await this.input.swipe(instance, {
              x1: step.x1,
              y1: step.y1,
              x2: step.x2,
              y2: step.y2,
              durationMs: step.durationMs ?? 300,
              normalized: step.normalized ?? false,
            });
            break;
          case 'text':
            await this.input.text(instance, { text: step.text, clearFirst: false });
            break;
          case 'keyevent':
            await this.input.keyevent(instance, step.key);
            break;
          case 'sleep':
            await new Promise((r) => setTimeout(r, step.ms));
            break;
          case 'assertVisible': {
            const nodes = await this.find(instance, step.selector);
            if (nodes.length === 0) throw new Error('Assertion failed: element not visible');
            break;
          }
        }
        results.push({ step: i + 1, action: step.action, ok: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ step: i + 1, action: step.action, ok: false, detail });
        if (input.stopOnError) {
          return { ok: false, results };
        }
      }
    }

    return { ok: results.every((r) => r.ok), results };
  }
}
