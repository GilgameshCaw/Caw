# Story: Implement Redis Caching Layer

## Story ID: SPRINT2-006
## Priority: HIGH
## Estimated Points: 5
## Agent: Backend Dev & Performance Engineer

## Context
The system makes repetitive database queries for the same data, causing unnecessary load and slower response times. A comprehensive Redis caching strategy will significantly improve performance and reduce database pressure.

### Requirements
- Cache frequently accessed data
- Implement cache invalidation strategy
- Handle cache stampede prevention
- Monitor cache effectiveness
- Ensure data consistency

### Related Components
- `/client/src/api/` - All API routes
- Redis server (already running)
- Database queries across all services

## Implementation Details

### Step 1: Create Cache Manager
```typescript
// src/utils/CacheManager.ts
import Redis from 'ioredis';

export class CacheManager {
  private redis: Redis;
  private prefix: string = 'caw:';

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });
  }

  // Generate consistent cache keys
  key(namespace: string, ...parts: any[]): string {
    return `${this.prefix}${namespace}:${parts.join(':')}`;
  }

  // Get with cache-aside pattern
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 300
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fetch from source
    const data = await fetcher();

    // Store in cache
    await this.redis.setex(key, ttl, JSON.stringify(data));

    return data;
  }

  // Implement cache stampede prevention
  async getOrSetWithLock<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 300
  ): Promise<T> {
    const lockKey = `${key}:lock`;
    const lockTTL = 30; // 30 seconds lock

    // Try to get from cache
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }

    // Try to acquire lock
    const lockAcquired = await this.redis.set(
      lockKey,
      '1',
      'NX',
      'EX',
      lockTTL
    );

    if (!lockAcquired) {
      // Another process is fetching, wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.getOrSetWithLock(key, fetcher, ttl);
    }

    try {
      // Fetch data
      const data = await fetcher();

      // Store in cache
      await this.redis.setex(key, ttl, JSON.stringify(data));

      return data;
    } finally {
      // Release lock
      await this.redis.del(lockKey);
    }
  }

  // Invalidate cache patterns
  async invalidate(pattern: string): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}${pattern}`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  // Tag-based cache invalidation
  async setWithTags<T>(
    key: string,
    data: T,
    ttl: number,
    tags: string[]
  ): Promise<void> {
    // Store data
    await this.redis.setex(key, ttl, JSON.stringify(data));

    // Store tags
    for (const tag of tags) {
      await this.redis.sadd(`tag:${tag}`, key);
      await this.redis.expire(`tag:${tag}`, ttl);
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    const keys = await this.redis.smembers(`tag:${tag}`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
      await this.redis.del(`tag:${tag}`);
    }
  }
}

export const cacheManager = new CacheManager();
```

### Step 2: Cache User Data
```typescript
// src/api/routes/users.ts
import { cacheManager } from '../../utils/CacheManager';

router.get('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id);

  const user = await cacheManager.getOrSet(
    cacheManager.key('user', userId),
    async () => {
      return await prisma.user.findUnique({
        where: { id: userId },
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
    },
    600 // 10 minutes TTL
  );

  res.json(user);
});

// Invalidate on update
router.put('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: req.body
  });

  // Invalidate cache
  await cacheManager.invalidate(`user:${userId}*`);

  res.json(updated);
});
```

### Step 3: Cache Feed Data
```typescript
// src/api/routes/caws.ts
router.get('/caws/feed', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const userId = req.user?.id;

  const feed = await cacheManager.getOrSetWithLock(
    cacheManager.key('feed', userId || 'public', page, limit),
    async () => {
      return await prisma.caw.findMany({
        where: { status: 'SUCCESS' },
        include: {
          user: true,
          _count: {
            select: { likes: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      });
    },
    60 // 1 minute TTL for feed
  );

  res.json(feed);
});

// Invalidate feed on new post
async function onNewCaw(caw: any) {
  // Invalidate all feed caches
  await cacheManager.invalidate('feed:*');

  // Or more granular invalidation
  await cacheManager.invalidateByTag('feed');
}
```

### Step 4: Cache Hashtags
```typescript
// src/api/routes/hashtags.ts
router.get('/hashtags/trending', async (req, res) => {
  const trending = await cacheManager.getOrSet(
    'hashtags:trending',
    async () => {
      return await prisma.hashtag.findMany({
        orderBy: { usageCount: 'desc' },
        take: 10,
        include: {
          _count: {
            select: { caws: true }
          }
        }
      });
    },
    300 // 5 minutes TTL
  );

  res.json(trending);
});
```

### Step 5: Session Store in Redis
```typescript
// src/api/middleware/session.ts
import session from 'express-session';
import RedisStore from 'connect-redis';

const sessionStore = new RedisStore({
  client: redis,
  prefix: 'session:',
  ttl: 86400 // 1 day
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
```

### Step 6: Cache Warming Strategy
```typescript
// src/services/CacheWarmer/index.ts
class CacheWarmer {
  async warmCache() {
    console.log('Starting cache warming...');

    // Warm popular user profiles
    const popularUsers = await prisma.user.findMany({
      orderBy: { followerCount: 'desc' },
      take: 100
    });

    for (const user of popularUsers) {
      await cacheManager.setWithTags(
        cacheManager.key('user', user.id),
        user,
        3600,
        ['users', 'popular']
      );
    }

    // Warm trending hashtags
    const trending = await this.getTrendingHashtags();
    await cacheManager.set('hashtags:trending', trending, 300);

    console.log('Cache warming complete');
  }

  // Run periodically
  start() {
    this.warmCache();
    setInterval(() => this.warmCache(), 60000); // Every minute
  }
}
```

### Step 7: Monitor Cache Performance
```typescript
// src/utils/CacheMetrics.ts
class CacheMetrics {
  private hits = 0;
  private misses = 0;

  recordHit() {
    this.hits++;
  }

  recordMiss() {
    this.misses++;
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  async logMetrics() {
    const info = await redis.info('stats');
    const hitRate = this.getHitRate();

    console.log({
      hitRate: `${(hitRate * 100).toFixed(2)}%`,
      hits: this.hits,
      misses: this.misses,
      memoryUsage: info.used_memory_human,
      evictedKeys: info.evicted_keys
    });
  }
}
```

## Acceptance Criteria
- [ ] CacheManager implemented and tested
- [ ] User profiles cached with 10min TTL
- [ ] Feed data cached with 1min TTL
- [ ] Hashtags cached with 5min TTL
- [ ] Cache invalidation working correctly
- [ ] Cache stampede prevention implemented
- [ ] Session store migrated to Redis
- [ ] Cache metrics dashboard available
- [ ] Cache hit rate > 80%
- [ ] API response time improved by 50%

## Testing Requirements

### Unit Tests
1. Test cache key generation
2. Test cache get/set operations
3. Test invalidation patterns
4. Test lock mechanism

### Integration Tests
1. Test cache warming
2. Test invalidation on updates
3. Test concurrent access
4. Test cache expiry

### Performance Tests
1. Measure response time improvement
2. Test cache hit rates
3. Test memory usage
4. Test eviction policies

## Dependencies
- ioredis (already installed)
- connect-redis for sessions
- No additional packages needed

## Monitoring & Alerts
- Monitor cache hit rate
- Alert if hit rate < 60%
- Monitor Redis memory usage
- Alert on connection failures

## Success Metrics
- Cache hit rate > 80%
- API response time < 100ms (p95)
- Redis memory usage < 1GB
- Zero cache-related errors