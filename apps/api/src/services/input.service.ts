import type {
  DoubleTapInput,
  GestureInput,
  InstanceRecord,
  LongPressInput,
  SwipeInput,
  TapInput,
  TextInput,
} from '@droidforge/shared';
import type { AdbExecutor } from './adb.service.js';

const KEYEVENT_MAP: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  CLEAR: 28,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  BACKSPACE: 67,
  MENU: 82,
  SEARCH: 84,
  ESCAPE: 111,
  APP_SWITCH: 187,
  RECENTS: 187,
  WAKEUP: 224,
  SLEEP: 223,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class InputService {
  constructor(private readonly adb: AdbExecutor) {}

  resolveCoords(instance: InstanceRecord, x: number, y: number, normalized = false): { x: number; y: number } {
    if (normalized) {
      return {
        x: Math.round(Math.max(0, Math.min(1, x)) * instance.width),
        y: Math.round(Math.max(0, Math.min(1, y)) * instance.height),
      };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  async tap(instance: InstanceRecord, input: TapInput): Promise<{ x: number; y: number }> {
    const pt = this.resolveCoords(instance, input.x, input.y, input.normalized);
    await this.adb.shell(instance.adbTarget, `input tap ${pt.x} ${pt.y}`);
    return pt;
  }

  async doubleTap(instance: InstanceRecord, input: DoubleTapInput): Promise<{ x: number; y: number }> {
    const pt = this.resolveCoords(instance, input.x, input.y, input.normalized);
    await this.adb.shell(instance.adbTarget, `input tap ${pt.x} ${pt.y}`);
    await sleep(input.intervalMs);
    await this.adb.shell(instance.adbTarget, `input tap ${pt.x} ${pt.y}`);
    return pt;
  }

  async longPress(instance: InstanceRecord, input: LongPressInput): Promise<{ x: number; y: number }> {
    const pt = this.resolveCoords(instance, input.x, input.y, input.normalized);
    await this.adb.shell(instance.adbTarget, `input swipe ${pt.x} ${pt.y} ${pt.x} ${pt.y} ${input.durationMs}`);
    return pt;
  }

  async swipe(instance: InstanceRecord, input: SwipeInput): Promise<void> {
    const p1 = this.resolveCoords(instance, input.x1, input.y1, input.normalized);
    const p2 = this.resolveCoords(instance, input.x2, input.y2, input.normalized);
    await this.adb.shell(
      instance.adbTarget,
      `input swipe ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${input.durationMs}`,
    );
  }

  async text(instance: InstanceRecord, input: TextInput): Promise<void> {
    if (input.clearFirst) {
      await this.adb.shell(instance.adbTarget, 'input keyevent 123'); // MOVE_END
      await this.adb.shell(instance.adbTarget, 'input keyevent --longpress 67 67 67 67 67');
    }
    // Escape shell metacharacters and spaces for `input text`
    const escaped = input.text
      .replace(/\\/g, '\\\\')
      .replace(/ /g, '%s')
      .replace(/(['"&|<>()$`!;#*?~])/g, '\\$1');
    await this.adb.shell(instance.adbTarget, `input text "${escaped}"`);
  }

  async keyevent(instance: InstanceRecord, key: string | number): Promise<number> {
    const code =
      typeof key === 'number'
        ? key
        : KEYEVENT_MAP[key.toUpperCase().replace(/^KEYCODE_/, '')] ?? Number(key);

    if (!Number.isInteger(code) || code < 0) {
      throw new Error(`Unsupported keyevent: ${String(key)}`);
    }
    await this.adb.shell(instance.adbTarget, `input keyevent ${code}`);
    return code;
  }

  async gesture(instance: InstanceRecord, input: GestureInput): Promise<number> {
    let executed = 0;
    for (const step of input.steps) {
      if (step.type === 'tap') {
        await this.tap(instance, { x: step.x, y: step.y, normalized: step.normalized ?? false });
      } else if (step.type === 'swipe') {
        await this.swipe(instance, {
          x1: step.x1,
          y1: step.y1,
          x2: step.x2,
          y2: step.y2,
          durationMs: step.durationMs ?? 300,
          normalized: step.normalized ?? false,
        });
      } else if (step.type === 'text') {
        await this.text(instance, { text: step.text, clearFirst: false });
      } else if (step.type === 'keyevent') {
        await this.keyevent(instance, step.key);
      } else if (step.type === 'wait') {
        await sleep(step.ms);
      }
      executed++;
    }
    return executed;
  }
}
