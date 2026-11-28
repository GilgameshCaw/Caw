"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const { loadSource } = require('./loadSource.cjs');
const { markTxQueueFailed } = loadSource(require.resolve('../../src/utils/txQueueFailure.ts'), {
    '../services/CountManager': {},
    './decompressActionText': {},
    '../services/NotificationService': {},
    './sanitizeFailureReason': { sanitizeFailureReason: (reason) => reason },
});
(0, node_test_1.describe)('markTxQueueFailed', () => {
    (0, node_test_1.it)('rolls back queue status if optimistic cleanup fails, so a retry can commit both', async () => {
        const failure = new Error('scheduled cleanup write failed');
        let shouldFail = true;
        const committed = { queue: 'submitted', caw: 'PENDING', scheduled: 'published' };
        function writer(state) {
            return {
                txQueue: {
                    async findUnique() { return { batchId: null }; },
                    async update() { state.queue = 'failed'; return { batchId: null }; },
                },
                caw: { async updateMany() { state.caw = 'FAILED'; } },
                scheduledCaw: {
                    async updateMany() {
                        if (shouldFail)
                            throw failure;
                        state.scheduled = 'failed';
                    },
                },
            };
        }
        const prisma = {
            ...writer(committed),
            async $transaction(work) {
                const pending = { ...committed };
                const result = await work(writer(pending));
                Object.assign(committed, pending);
                return result;
            },
        };
        const markFailed = () => markTxQueueFailed(prisma, 1, 'Cawonce already used', 2, { actionType: 0, cawonce: 3 });
        const result = await markFailed().then(() => undefined, (error) => error);
        strict_1.default.deepEqual({ error: result, ...committed }, {
            error: failure, queue: 'submitted', caw: 'PENDING', scheduled: 'published',
        });
        shouldFail = false;
        await markFailed();
        strict_1.default.deepEqual(committed, { queue: 'failed', caw: 'FAILED', scheduled: 'failed' });
    });
});
