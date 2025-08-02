import process from 'node:process';
import {z} from 'zod';
import {type Service} from './Service';
import { rawEventsGathererService } from './services/RawEventsGatherer';
import { actionProcessorService } from './services/ActionProcessor';
import { validatorService } from './services/ValidatorService';
import { frontEndService } from './services/FrontEnd';
import { apiService } from './services/Api'

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

    if (sigintCount > 2) {
      console.error('SIGINT caught again, force exiting');
      process.exit(1);
    }

    console.warn(
      'SIGINT caught. Services have 30s to stop. Use three SIGINTs to exit immediately.',
    );

    setTimeout(() => {
      console.error('Services not stopped in 30s');
      process.exit(1);
    }, 30_000).unref();

    await Promise.all(runningInstances.map(async (i) => i.stop()));
    process.exit(0);
  });
}

function runInstance(instance: InstanceReady): {stop(): Promise<void>} {
  let stopService = async () => {};
  let alive = true;
  let retryDelay = 1000;

  (async () => {
    let startResult: ReturnType<Service['start']>;

    while (alive) {
      startResult = instance.service.start(instance.config);
      stopService = async () => startResult.stop();

      try {
        await startResult.started;
        break;
      } catch (error) {
        console.error(
          `Starting ${instance.instance} failed, retrying in ${retryDelay.toFixed(0)}ms`,
          error,
        );

        startResult.stop().catch(console.error);

        await delay(retryDelay);
        retryDelay *= 1.05;
      }
    }

    console.log(`Instance ${instance.instance} started`);

    await delay(Math.random() * 60_000);

    while (alive) {
      const stats = await startResult!.stats();
      console.log(`stats for ${instance.instance}:`, stats);
      await delay(59_000 + 2000 * Math.random());
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
