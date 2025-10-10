# Story: Optimize Database Queries

## Story ID: SPRINT2-005
## Priority: HIGH
## Estimated Points: 8
## Agent: Backend Dev & Performance Engineer

## Context
Database query performance is degrading as data volume grows. Several queries lack proper indexes, use inefficient patterns, and don't leverage database capabilities effectively. This impacts user experience with slow page loads and API response times.

### Current Issues
- Feed queries take 2-5 seconds with large datasets
- Missing indexes on frequently queried columns
- N+1 query problems in multiple endpoints
- No query result caching
- Inefficient JOIN operations

### Related Components
- `/client/src/api/routes/caws.ts` - Feed queries
- `/client/src/api/routes/users.ts` - Profile queries
- `/client/src/services/ActionProcessor/index.ts` - Event processing
- Database: PostgreSQL with Prisma ORM

## Implementation Details

### Step 1: Identify Slow Queries
```typescript
// Add query logging to identify bottlenecks
const prismaWithLogging = new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
  ],
});

prismaWithLogging.$on('query', (e) => {
  if (e.duration > 1000) {
    console.warn(`Slow query (${e.duration}ms):`, e.query);
    // Log to monitoring system
  }
});
```

### Step 2: Add Missing Indexes
```sql
-- Critical indexes for performance
CREATE INDEX CONCURRENTLY idx_caw_userid_status_created
ON "Caw" ("userId", "status", "createdAt" DESC);

CREATE INDEX CONCURRENTLY idx_caw_status_created
ON "Caw" ("status", "createdAt" DESC);

CREATE INDEX CONCURRENTLY idx_like_cawid_userid
ON "Like" ("cawId", "userId");

CREATE INDEX CONCURRENTLY idx_follow_followerid_followingid
ON "Follow" ("followerId", "followingId");

CREATE INDEX CONCURRENTLY idx_txqueue_status_created
ON "TxQueue" ("status", "createdAt");

CREATE INDEX CONCURRENTLY idx_action_senderid_type_created
ON "Action" ("senderId", "actionType", "createdAt" DESC);

-- Composite indexes for common queries
CREATE INDEX CONCURRENTLY idx_caw_hashtag_composite
ON "CawHashtag" ("hashtagId", "cawId");

-- Full text search index
CREATE INDEX CONCURRENTLY idx_caw_content_fts
ON "Caw" USING gin(to_tsvector('english', "content"));
```

### Step 3: Optimize Feed Query
```typescript
// Current inefficient query
const feed = await prisma.caw.findMany({
  where: { status: 'SUCCESS' },
  include: {
    user: true,
    likes: true,
    hashtags: {
      include: { hashtag: true }
    }
  },
  orderBy: { createdAt: 'desc' },
  take: 50
});

// Optimized query with selective loading
const feedOptimized = await prisma.$queryRaw`
  WITH feed_caws AS (
    SELECT
      c.*,
      u.username,
      u.avatar_url,
      COUNT(DISTINCT l.id) as like_count,
      EXISTS(
        SELECT 1 FROM "Like"
        WHERE "cawId" = c.id AND "userId" = ${currentUserId}
      ) as user_liked,
      ARRAY_AGG(DISTINCT h.name) FILTER (WHERE h.name IS NOT NULL) as hashtags
    FROM "Caw" c
    INNER JOIN "User" u ON c."userId" = u.id
    LEFT JOIN "Like" l ON c.id = l."cawId"
    LEFT JOIN "CawHashtag" ch ON c.id = ch."cawId"
    LEFT JOIN "Hashtag" h ON ch."hashtagId" = h.id
    WHERE c.status = 'SUCCESS'
    GROUP BY c.id, u.username, u.avatar_url
    ORDER BY c."createdAt" DESC
    LIMIT 50
  )
  SELECT * FROM feed_caws;
`;
```

### Step 4: Implement Query Result Caching
```typescript
// Redis caching layer
class QueryCache {
  private redis: Redis;
  private defaultTTL = 300; // 5 minutes

  async get<T>(key: string): Promise<T | null> {
    const cached = await this.redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    await this.redis.setex(
      key,
      ttl || this.defaultTTL,
      JSON.stringify(value)
    );
  }

  async invalidate(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

// Usage in API
async function getCawsFeed(userId: number, page: number) {
  const cacheKey = `feed:${userId}:${page}`;

  // Check cache first
  const cached = await queryCache.get(cacheKey);
  if (cached) return cached;

  // Query database
  const feed = await optimizedFeedQuery(userId, page);

  // Cache result
  await queryCache.set(cacheKey, feed, 60);

  return feed;
}
```

### Step 5: Fix N+1 Query Problems
```typescript
// Problem: N+1 queries when loading user profiles
// Bad: Makes separate query for each user's stats
const users = await prisma.user.findMany();
for (const user of users) {
  user.cawCount = await prisma.caw.count({ where: { userId: user.id }});
  user.followerCount = await prisma.follow.count({ where: { followingId: user.id }});
}

// Solution: Single query with aggregation
const usersWithStats = await prisma.user.findMany({
  include: {
    _count: {
      select: {
        caws: true,
        followers: true,
        following: true
      }
    }
  }
});
```

### Step 6: Database Connection Pooling
```typescript
// Configure connection pool
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Connection pool settings
  connectionLimit: 10, // Max connections in pool
});

// Monitor pool usage
setInterval(async () => {
  const metrics = await prisma.$metrics.json();
  console.log('Database pool metrics:', {
    idle: metrics.counters.find(m => m.key === 'prisma_pool_connections_idle')?.value,
    busy: metrics.counters.find(m => m.key === 'prisma_pool_connections_busy')?.value,
    wait: metrics.histograms.find(m => m.key === 'prisma_pool_wait_duration')?.value,
  });
}, 30000);
```

### Step 7: Implement Read Replicas
```typescript
// Configure read replica for queries
const writeDb = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL }
  }
});

const readDb = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_READ_REPLICA_URL }
  }
});

// Route queries appropriately
async function getCaw(id: number) {
  // Read operations go to replica
  return readDb.caw.findUnique({ where: { id }});
}

async function createCaw(data: any) {
  // Write operations go to primary
  return writeDb.caw.create({ data });
}
```

## Acceptance Criteria
- [ ] All slow queries identified and logged
- [ ] Critical indexes added without downtime
- [ ] Feed query time < 100ms for 1M+ records
- [ ] Redis caching implemented for hot paths
- [ ] N+1 queries eliminated
- [ ] Connection pooling configured optimally
- [ ] Query performance dashboard created
- [ ] 90% reduction in average query time
- [ ] Database CPU usage reduced by 50%

## Testing Requirements

### Performance Tests
1. Benchmark queries with 1M+ records
2. Test concurrent user load (1000+ users)
3. Measure cache hit rates
4. Test index effectiveness

### Load Tests
1. Simulate peak traffic patterns
2. Test connection pool limits
3. Measure response times under load
4. Test cache invalidation

## Database Changes
See Step 2 for index creation scripts. All indexes created with CONCURRENTLY to avoid locking.

## Dependencies
- Redis for caching (existing)
- pg_stat_statements for query analysis
- No new npm packages required

## Monitoring & Alerts
- Alert if query time > 1 second
- Monitor cache hit rate (target > 80%)
- Track database connections
- Monitor index usage

## Success Metrics
- Average API response time < 200ms
- Database CPU usage < 50%
- Query cache hit rate > 80%
- Zero timeout errors from slow queries