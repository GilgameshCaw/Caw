# Story: Fix Timeout Handling in ValidatorService

## Story ID: SPRINT1-001
## Priority: HIGH
## Estimated Points: 5
## Agent: Backend Dev

## Context
The ValidatorService currently marks RPC timeout errors as permanent failures, causing legitimate transactions to be abandoned. This is problematic because RPC timeouts are often temporary network issues that should be retried, not treated as permanent failures.

### Current Behavior
- RPC calls timeout after 60 seconds
- Timeouts are marked as 'failed' in TxQueue
- Caw status changes to 'FAILED' permanently
- No retry mechanism exists

### Related Components
- `/client/src/services/ValidatorService/index.ts` - Main service file
- Database: TxQueue table (status field)
- Database: Caw table (status field)
- Smart Contracts: CawActions.sol

## Implementation Details

### Step 1: Modify Timeout Detection
```typescript
// In ValidatorService/index.ts, around line 139
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => {
    console.warn(`RPC call timing out after ${timeout}ms - will retry. Consider checking RPC endpoint health.`)
    reject(new Error(`TIMEOUT after ${timeout}ms`))
  }, timeout)
})
```

### Step 2: Add Timeout Flag to Response
```typescript
// In the catch block for simulating actions
if (err.message?.includes('TIMEOUT')) {
  // Return special indicator for timeout
  return null; // This will signal to keep as pending
}

// After collecting all responses
if (rejectionMessages.every(msg => msg === null)) {
  return {
    successfulActions: [],
    rejectionMessages: [],
    isTimeout: true,
    quote: { nativeFee: BigInt(0) }
  };
}
```

### Step 3: Update Status Logic
```typescript
// In the status update section
if (isTimeout) {
  console.log("Simulation timed out - keeping entries as pending for retry")
  return // Don't update status, leave as pending
}
```

### Step 4: Implement Exponential Backoff
```typescript
// Add retry count tracking
const baseTimeout = 60000; // 60 seconds
const maxRetries = 5;
const retryCount = await getRetryCount(txQueueId); // Track in DB or memory
const timeout = baseTimeout * Math.pow(1.5, retryCount);

// After max retries, mark as failed
if (retryCount >= maxRetries) {
  // Mark as permanently failed
  await updateStatus('failed', 'Max retries exceeded');
}
```

## Acceptance Criteria
- [ ] Timeouts do not immediately mark transactions as failed
- [ ] Transactions remain in 'pending' status after timeout
- [ ] Retry attempts use exponential backoff (60s, 90s, 135s, etc.)
- [ ] Maximum retry limit of 5 attempts implemented
- [ ] Monitoring logs capture all timeout events with timestamps
- [ ] Unit tests cover timeout scenarios
- [ ] Integration test simulates RPC timeout and verifies retry behavior

## Testing Requirements

### Unit Tests
1. Test timeout detection logic
2. Test exponential backoff calculation
3. Test max retry limit enforcement
4. Test isTimeout flag propagation

### Integration Tests
1. Simulate RPC timeout using mock
2. Verify transaction remains pending
3. Confirm retry with increased timeout
4. Test maximum retry limit
5. Validate monitoring output

### Manual Testing
1. Start validator with a slow/unreliable RPC endpoint
2. Submit a new CAW action
3. Observe timeout and retry behavior
4. Verify eventual success or failure after retries

## Database Changes
```sql
-- Optional: Add retry_count column to TxQueue
ALTER TABLE "TxQueue"
ADD COLUMN "retry_count" INTEGER DEFAULT 0;

-- Optional: Add last_retry_at timestamp
ALTER TABLE "TxQueue"
ADD COLUMN "last_retry_at" TIMESTAMP;
```

## Dependencies
- No new npm packages required
- Existing Promise.race pattern utilized
- Current logging infrastructure sufficient

## Monitoring & Alerts
- Log all timeout occurrences with severity WARN
- Track retry attempts per transaction
- Alert if timeout rate exceeds 10% of transactions
- Dashboard metric: Average retries until success

## Rollback Plan
1. Revert ValidatorService changes
2. Clear any stuck 'pending' transactions
3. Resume previous behavior

## Technical Notes
- Consider implementing circuit breaker pattern if RPC consistently fails
- May need to adjust timeout based on network conditions
- Consider separate timeout for read vs write operations
- Future enhancement: Multiple RPC endpoint failover

## Success Metrics
- Reduction in permanently failed transactions by 80%
- Average successful retry within 3 attempts
- User-reported timeout issues reduced to near zero
- System uptime improved due to better resilience