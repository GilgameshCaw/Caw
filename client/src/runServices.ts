import process from 'node:process';
import {z} from 'zod';
import {type Service, type HeartbeatContext} from './Service';
import { rawEventsGathererService } from './services/RawEventsGatherer';
import { actionProcessorService } from './services/ActionProcessor';
import { validatorService } from './services/ValidatorService';
import { frontEndService } from './services/FrontEnd';
import { apiService } from './services/Api'
import { dataCleanerService } from './services/DataCleaner';
import { scheduledPostProcessorService } from './services/ScheduledPostProcessor';
import { instanceRegistryService } from './services/InstanceRegistryService';
import { chainSyncService } from './services/ChainSyncService';
import { marketplaceIndexerService } from './services/MarketplaceIndexerService';
import { nftTransferWatcherService } from './services/NftTransferWatcher';

import delay from './tools/delay';


type InstanceReady = {
  service: Service;
  instance: string;
  config: unknown;
};

// eslint-disable-next-line @typescript-eslint/naming-convention
const InstanceConfig = z.object({
  service: z.string(),
  instance: z.optional(z.string()),
  config: z.unknown(),
});

// eslint-disable-next-line @typescript-eslint/no-redeclare
type InstanceConfig = z.TypeOf<typeof InstanceConfig>;

// eslint-disable-next-line @typescript-eslint/naming-convention
const RunServicesConfig = z.array(InstanceConfig);

// eslint-disable-next-line @typescript-eslint/no-redeclare
type RunServicesConfig = z.TypeOf<typeof RunServicesConfig>;

export {RunServicesConfig};

const availableServiceList: Service[] = [
  rawEventsGathererService,
  actionProcessorService,
  validatorService,
  frontEndService,
  apiService,
  dataCleanerService,
  scheduledPostProcessorService,
  instanceRegistryService,
  chainSyncService,
  marketplaceIndexerService,
  nftTransferWatcherService,
];

const availableServices = new Map<string, Service>();

for (const service of availableServiceList) {
  if (availableServices.has(service.name)) {
    throw new Error(`Duplicate available service: ${service.name}`);
  }

  availableServices.set(service.name, service);
}

export default function runServices(fullConfig: RunServicesConfig) {
  const instances = new Map<string, InstanceReady>();

  for (const instanceConfig of fullConfig) {
    const instanceName = instanceConfig.instance ?? instanceConfig.service;

    if (instances.has(instanceName)) {
      throw new Error(`Duplicate instance ${instanceName}`);
    }

    const service = availableServices.get(instanceConfig.service);

    if (!service) {
      throw new Error(`No available service found: ${instanceConfig.service}`);
    }

    const validationErrors = service.validateConfig(instanceConfig.config);

    if (validationErrors.length > 0) {
      for (const e of validationErrors) {
        console.error(e);
      }

      throw new Error(
        `${instanceName} config validation: ${validationErrors.length} failure(s)`,
      );
    }

    instances.set(instanceName, {
      service,
      instance: instanceName,
      config: instanceConfig.config,
    });
  }

  const runningInstances = Array.from(instances.values()).map((i) =>
    runInstance(i),
  );

  let sigintCount = 0;

  process.on('SIGINT', async () => {
    sigintCount++;

    if (sigintCount >= 2) {
      console.error('Force exiting');
      process.exit(1);
    }

    console.warn(
      'SIGINT caught. Stopping services... Press Ctrl+C again to force exit.',
    );

    setTimeout(() => {
      console.error('Services not stopped in 10s, force exiting');
      process.exit(1);
    }, 10_000).unref();

    await Promise.all(runningInstances.map(async (i) => i.stop()));
    process.exit(0);
  });
}

// Default time a loop can go without a heartbeat before the watchdog
// declares it dead and restarts the service. Individual loops can
// override this by calling ctx.declareLoop(name, timeoutMs).
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60_000; // 5 minutes

// How often the watchdog checks heartbeats.
const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;

type LoopState = {
  lastHeartbeat: number;
  timeoutMs: number;
};

function runInstance(instance: InstanceReady): {stop(): Promise<void>} {
  let stopService = async () => {};
  let alive = true;

  (async () => {
    while (alive) {
      let startResult: ReturnType<Service['start']> | undefined;
      let retryDelay = 1000;

      // Per-loop heartbeat tracking. Reset on every (re)start so a fresh
      // service doesn't get tripped up by stale timestamps from the last
      // incarnation.
      const loops = new Map<string, LoopState>();
      const ctx: HeartbeatContext = {
        heartbeat(loopName = 'main') {
          const existing = loops.get(loopName);
          if (existing) {
            existing.lastHeartbeat = Date.now();
          } else {
            loops.set(loopName, {
              lastHeartbeat: Date.now(),
              timeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
            });
          }
        },
        declareLoop(loopName, timeoutMs) {
          loops.set(loopName, {
            lastHeartbeat: Date.now(),
            timeoutMs,
          });
        },
      };

      // Phase 1: Start the service (retry until it starts)
      while (alive) {
        try {
          startResult = instance.service.start(instance.config, ctx);
          stopService = async () => startResult!.stop();

          await startResult.started;
          break;
        } catch (error) {
          console.error(
            `Starting ${instance.instance} failed, retrying in ${retryDelay.toFixed(0)}ms`,
            error,
          );

          if (startResult) {
            startResult.stop().catch(console.error);
            startResult = undefined;
          }

          await delay(retryDelay);
          retryDelay = Math.min(retryDelay * 1.05, 30_000);
        }
      }

      if (!alive || !startResult) break;

      console.log(`Instance ${instance.instance} started`);

      // Phase 2: Monitor via heartbeats AND stats — restart on either signal
      let crashReason: Error | undefined;
      try {
        // Grace period on first start so services have time to run their
        // first loop iteration before we expect heartbeats.
        await delay(HEARTBEAT_CHECK_INTERVAL_MS);

        let statsCountdown = 0; // Count ticks until we log stats
        while (alive) {
          // Check every declared loop for staleness
          const now = Date.now();
          const loopEntries = Array.from(loops.entries());
          for (const [loopName, state] of loopEntries) {
            const age = now - state.lastHeartbeat;
            if (age > state.timeoutMs) {
              throw new Error(
                `heartbeat stale for loop '${loopName}': ${Math.round(age / 1000)}s > ${Math.round(state.timeoutMs / 1000)}s`,
              );
            }
          }

          // Still call stats() — gives a free liveness signal AND useful log output.
          // If stats() throws, treat it as a crash too.
          const stats = await startResult.stats();

          // Log stats less often than we check heartbeats, to avoid log spam
          if (statsCountdown <= 0) {
            const loopSummary = Array.from(loops.entries())
              .map(([name, s]) => `${name}=${Math.round((now - s.lastHeartbeat) / 1000)}s`)
              .join(', ');
            console.log(
              `stats for ${instance.instance}:`,
              stats,
              loopSummary ? `[loops: ${loopSummary}]` : '[no heartbeats yet]',
            );
            statsCountdown = 2; // Log every ~60s if check interval is 30s
          } else {
            statsCountdown--;
          }

          await delay(HEARTBEAT_CHECK_INTERVAL_MS);
        }
      } catch (error) {
        crashReason = error instanceof Error ? error : new Error(String(error));
        if (!alive) break;
        console.error(
          `[runServices] ${instance.instance} crashed, restarting in 5s...`,
          crashReason.message,
        );
        if (crashReason.stack) {
          console.error(crashReason.stack);
        }

        // Stop the dead service before restarting
        try { await startResult.stop(); } catch { /* ignore cleanup errors */ }

        await delay(5000);
        // Loop back to Phase 1 to restart
      }
    }
  })();

  return {
    async stop() {
      alive = false;
      await stopService();
      console.log(`Stopped ${instance.instance}`);
    },
  };
}
