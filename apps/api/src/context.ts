import type { AppEnv } from './config/env.js';
import type { StateStore } from './db/database.js';
import type { RedroidDockerManager } from './docker/redroid-docker.manager.js';
import type { AdbExecutor } from './services/adb.service.js';
import type { AiSnapshotService } from './services/ai-snapshot.service.js';
import type { H264StreamService } from './services/h264-stream.service.js';
import type { InputService } from './services/input.service.js';
import type { InstanceOrchestrator } from './services/instance.orchestrator.js';
import type { ProxyRelayService } from './services/proxy-relay.service.js';
import type { PruneService } from './services/prune.service.js';
import type { RecordingService } from './services/recording.service.js';
import type { StealthService } from './services/stealth.service.js';
import type { StreamService } from './services/stream.service.js';
import type { UiAutomationService } from './services/ui-automation.service.js';

export interface AppContext {
  env: AppEnv;
  store: StateStore;
  docker: RedroidDockerManager;
  adb: AdbExecutor;
  stealth: StealthService;
  proxyRelay: ProxyRelayService;
  recordings: RecordingService;
  prune: PruneService;
  input: InputService;
  ui: UiAutomationService;
  aiSnapshot: AiSnapshotService;
  stream: StreamService;
  h264: H264StreamService;
  orchestrator: InstanceOrchestrator;
}
