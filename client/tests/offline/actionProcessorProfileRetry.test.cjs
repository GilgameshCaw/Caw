"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_events_1 = require("node:events");
const node_test_1 = require("node:test");
const { loadSource } = require('./loadSource.cjs');
(0, node_test_1.describe)('ActionProcessor profile lookup', () => {
    (0, node_test_1.it)('registers a backlog event for retry after a transient lookup failure before writing any action', async () => {
        const raw = {
            id: 42, chainId: 1, blockNumber: 1n, logIndex: 0, transactionHash: 'test', topics: [],
            data: [{ actionType: 0, senderId: 1 }, { actionType: 0, senderId: 2 }],
        };
        const transient = new Error('profile lookup unavailable');
        let actionWrites = 0;
        let registry;
        const mocks = {
            '../../prismaClient': { prisma: {
                    $connect: async () => { },
                    $disconnect: async () => { },
                    action: { findFirst: async () => null },
                    rawEvent: { findMany: async ({ where }) => where.id.gt < raw.id ? [raw] : [] },
                    chainData: {
                        findUnique: async () => null,
                        upsert: async ({ update }) => { registry = update.value; },
                    },
                    $transaction: async () => { actionWrites++; throw new Error('unexpected Action write'); },
                } },
            'ioredis': class extends node_events_1.EventEmitter {
                async subscribe() { }
                async quit() { }
                disconnect() { }
            },
            'zod': { z: {
                    string: () => ({ optional: () => ({ default: () => ({}) }) }),
                    object: () => ({ parse: (value) => value }),
                } },
            '@prisma/client': {},
            './actionCreation': {},
            './domainProcessor': {
                resolveActionUsers: async ({ senderId }) => {
                    if (senderId === 2)
                        throw transient;
                    return {};
                },
            },
            '../UserService': { StaleTokenError: class extends Error {
                } },
            './actionHandlers': { CawNotFoundError: class extends Error {
                } },
            '../../abi/addresses': { CAW_ACTIONS_ADDRESS: 'test' },
            '../../utils/trace': { span: (_name, _attrs, work) => work() },
            '../../abi/getActionType': () => 'CAW',
            '../StakeLedger': { verifyMultiplier: async () => { } },
        };
        const { actionProcessorService } = loadSource(require.resolve('../../src/services/ActionProcessor/index.ts'), mocks);
        const instance = actionProcessorService.start({ redisUrl: 'mock' }, {
            declareLoop() { },
            heartbeat() { },
        });
        try {
            await instance.started;
            strict_1.default.deepEqual({ actionWrites, retry: registry && registry[42]?.lastError }, {
                actionWrites: 0, retry: transient.message,
            });
        }
        finally {
            await instance.stop();
        }
    });
});
