import { getRepository } from 'typeorm';
import { Service } from '../../Service';
import { RawEvent } from '../../entity/RawEvent';  // Assuming you moved RawEvent to an entity folder as per TypeORM convention.

type RawEventsProviderConfig = Record<string, never>;

export const rawEventsProviderService: Service = {
  name: 'RawEventsProvider',

  validateConfig(config: unknown) {
		const errors: Error[] = [];  // Explicitly type the errors array as Error[]

    // No specific validation needed as we're using TypeORM directly
    return errors;
  },

  start(config: RawEventsProviderConfig) {
    const rawEventRepository = getRepository(RawEvent);

    const api = {
      async getLastProcessedEvent(): Promise<RawEvent | null> {
        return await rawEventRepository
          .createQueryBuilder('rawEvent')
          .orderBy('rawEvent.i', 'DESC')
          .getOne();
      },

      async storeEvent(event: RawEvent): Promise<void> {
        await rawEventRepository.save(event);
      },
    };

    return {
      started: Promise.resolve(),
      async stop() {
        // Any necessary cleanup can be done here
      },
      async stats() {
        return {}; // Provide any relevant statistics here
      },
      api,
    };
  },
};

