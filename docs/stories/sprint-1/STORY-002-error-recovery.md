# Story: Implement Comprehensive Error Recovery

## Story ID: SPRINT1-002
## Priority: HIGH
## Estimated Points: 8
## Agent: Backend Dev & QA

## Context
The system currently lacks comprehensive error recovery mechanisms, leading to data inconsistencies and poor user experience when failures occur. We need robust error handling across all services with proper recovery strategies.

### Current Issues
- Services crash on unhandled errors
- No automatic recovery mechanisms
- Lost events during service restarts
- Database inconsistencies after failures

### Related Components
- `/client/src/services/ValidatorService/index.ts`
- `/client/src/services/ActionProcessor/index.ts`
- `/client/src/services/RawEventsGatherer/index.ts`
- `/client/src/services/DataCleaner/index.ts`

## Implementation Details

### Step 1: Add Global Error Handlers
```typescript
// In each service's main file
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Log to monitoring service
  // Attempt graceful shutdown
  // Restart service
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log and recover
});
```

### Step 2: Implement Service Health Checks
```typescript
// Health check endpoint for each service
class ServiceHealth {
  private lastHealthCheck: Date;
  private isHealthy: boolean = true;
  private errors: Error[] = [];

  checkHealth(): HealthStatus {
    return {
      service: 'ValidatorService',
      healthy: this.isHealthy,
      lastCheck: this.lastHealthCheck,
      uptime: process.uptime(),
      errors: this.errors.slice(-10)
    };
  }

  reportError(error: Error) {
    this.errors.push(error);
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-100);
    }
  }
}
```

### Step 3: Add Circuit Breaker Pattern
```typescript
class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime?: Date;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = new Date();
    if (this.failures >= 5) {
      this.state = 'OPEN';
    }
  }
}
```

### Step 4: Implement Retry Queue
```typescript
class RetryQueue {
  private queue: Map<string, RetryItem> = new Map();

  async addForRetry(item: any, retryStrategy: RetryStrategy) {
    const retryItem = {
      id: generateId(),
      payload: item,
      attempts: 0,
      maxAttempts: retryStrategy.maxAttempts || 3,
      nextRetryAt: new Date(),
      strategy: retryStrategy
    };

    this.queue.set(retryItem.id, retryItem);
    await this.scheduleRetry(retryItem);
  }

  private async processRetries() {
    const now = new Date();
    for (const [id, item] of this.queue) {
      if (item.nextRetryAt <= now) {
        await this.attemptRetry(item);
      }
    }
  }
}
```

### Step 5: Add Database Transaction Recovery
```typescript
// Wrap all database operations in transactions
async function safeDbOperation(operation: () => Promise<void>) {
  const transaction = await prisma.$transaction(async (tx) => {
    try {
      await operation();
    } catch (error) {
      // Log the error
      console.error('Transaction failed:', error);
      // Mark for cleanup
      await tx.recoveryLog.create({
        data: {
          operation: operation.toString(),
          error: error.message,
          timestamp: new Date()
        }
      });
      throw error; // Rollback transaction
    }
  });
}
```

## Acceptance Criteria
- [ ] All services have global error handlers
- [ ] Health check endpoints return accurate status
- [ ] Circuit breaker prevents cascade failures
- [ ] Retry queue processes failed operations
- [ ] Database transactions rollback on failure
- [ ] Recovery logs capture all failures
- [ ] Services auto-restart on crash
- [ ] No data loss during service restarts
- [ ] Monitoring dashboard shows service health

## Testing Requirements

### Unit Tests
1. Test error handler responses
2. Test circuit breaker state transitions
3. Test retry queue logic
4. Test health check calculations

### Integration Tests
1. Simulate service crashes and verify recovery
2. Test database rollback scenarios
3. Verify event recovery after restart
4. Test circuit breaker with RPC failures

### Chaos Testing
1. Randomly kill services during operation
2. Simulate network partitions
3. Corrupt data and verify detection
4. Overload system and verify graceful degradation

## Database Changes
```sql
-- Create recovery log table
CREATE TABLE "RecoveryLog" (
  "id" SERIAL PRIMARY KEY,
  "service" VARCHAR(255) NOT NULL,
  "operation" TEXT,
  "error" TEXT,
  "recovered" BOOLEAN DEFAULT FALSE,
  "timestamp" TIMESTAMP NOT NULL,
  "recoveredAt" TIMESTAMP
);

-- Create service health table
CREATE TABLE "ServiceHealth" (
  "id" SERIAL PRIMARY KEY,
  "service" VARCHAR(255) NOT NULL,
  "status" VARCHAR(50) NOT NULL,
  "lastHealthCheck" TIMESTAMP NOT NULL,
  "uptime" INTEGER,
  "errorCount" INTEGER DEFAULT 0
);
```

## Dependencies
- No new packages required
- Utilize existing error handling
- Leverage Prisma transactions

## Monitoring & Alerts
- Alert on service crash
- Alert on circuit breaker open
- Track recovery success rate
- Monitor retry queue size
- Dashboard for service health

## Rollback Plan
1. Disable new error handlers
2. Revert to previous behavior
3. Clear recovery logs
4. Reset circuit breakers

## Success Metrics
- Service uptime > 99.9%
- Recovery time < 30 seconds
- Zero data loss during failures
- Error rate < 0.1%