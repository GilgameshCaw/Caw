# Story: Create Monitoring Dashboard

## Story ID: SPRINT1-004
## Priority: MEDIUM
## Estimated Points: 5
## Agent: Backend Dev & Frontend Dev

## Context
The system currently lacks visibility into operational health, making it difficult to identify and diagnose issues proactively. We need a comprehensive monitoring dashboard that tracks key metrics across all services.

### Requirements
- Real-time service health status
- Transaction processing metrics
- Error rates and types
- Performance metrics
- Queue sizes and processing times

### Related Components
- All services need health endpoints
- New dashboard UI component
- Redis for real-time metrics
- PostgreSQL for historical data

## Implementation Details

### Step 1: Create Metrics Collection Service
```typescript
// src/services/MetricsCollector/index.ts
interface Metric {
  service: string;
  type: 'counter' | 'gauge' | 'histogram';
  name: string;
  value: number;
  timestamp: Date;
  tags?: Record<string, string>;
}

class MetricsCollector {
  private metrics: Map<string, Metric[]> = new Map();
  private redis: Redis;

  async recordMetric(metric: Metric) {
    // Store in memory
    const key = `${metric.service}:${metric.name}`;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }
    this.metrics.get(key)!.push(metric);

    // Publish to Redis for real-time
    await this.redis.publish('metrics', JSON.stringify(metric));

    // Batch write to database
    if (this.metrics.get(key)!.length >= 100) {
      await this.flushMetrics(key);
    }
  }

  async flushMetrics(key: string) {
    const metrics = this.metrics.get(key) || [];
    if (metrics.length === 0) return;

    await prisma.metric.createMany({
      data: metrics
    });

    this.metrics.set(key, []);
  }
}
```

### Step 2: Add Health Endpoints to All Services
```typescript
// In each service, add health endpoint
app.get('/health', async (req, res) => {
  const health = {
    service: 'ValidatorService',
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date(),
    checks: {
      database: await checkDatabase(),
      redis: await checkRedis(),
      blockchain: await checkBlockchain()
    },
    metrics: {
      pendingTransactions: await getPendingCount(),
      processedToday: await getProcessedToday(),
      errorRate: await getErrorRate()
    }
  };

  res.json(health);
});

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
```

### Step 3: Create Dashboard API Endpoints
```typescript
// src/api/routes/monitoring.ts
router.get('/api/monitoring/overview', async (req, res) => {
  const overview = {
    services: await getServicesHealth(),
    metrics: await getKeyMetrics(),
    alerts: await getActiveAlerts(),
    recentErrors: await getRecentErrors()
  };
  res.json(overview);
});

router.get('/api/monitoring/metrics/:service', async (req, res) => {
  const { service } = req.params;
  const { period = '1h' } = req.query;

  const metrics = await prisma.metric.findMany({
    where: {
      service,
      timestamp: {
        gte: new Date(Date.now() - parsePeriod(period))
      }
    },
    orderBy: { timestamp: 'desc' }
  });

  res.json(metrics);
});
```

### Step 4: Create Dashboard Frontend Component
```typescript
// src/services/FrontEnd/src/pages/Monitoring.tsx
import React, { useEffect, useState } from 'react';
import { Line, Bar } from 'react-chartjs-2';

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  lastCheck: Date;
}

export function MonitoringDashboard() {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [metrics, setMetrics] = useState<any>({});

  useEffect(() => {
    const interval = setInterval(async () => {
      const response = await fetch('/api/monitoring/overview');
      const data = await response.json();
      setServices(data.services);
      setMetrics(data.metrics);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-4">
      <h1 className="text-2xl font-bold mb-6">System Monitoring</h1>

      {/* Services Health Grid */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {services.map(service => (
          <ServiceHealthCard key={service.name} service={service} />
        ))}
      </div>

      {/* Metrics Charts */}
      <div className="grid grid-cols-2 gap-4">
        <MetricChart
          title="Transaction Processing"
          data={metrics.transactionProcessing}
        />
        <MetricChart
          title="Error Rate"
          data={metrics.errorRate}
        />
      </div>

      {/* Recent Alerts */}
      <AlertsPanel alerts={metrics.alerts} />
    </div>
  );
}

function ServiceHealthCard({ service }: { service: ServiceHealth }) {
  const statusColor = {
    healthy: 'bg-green-500',
    degraded: 'bg-yellow-500',
    down: 'bg-red-500'
  }[service.status];

  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-semibold">{service.name}</h3>
        <div className={`w-3 h-3 rounded-full ${statusColor}`} />
      </div>
      <div className="text-sm text-gray-600">
        <p>Uptime: {formatUptime(service.uptime)}</p>
        <p>Last check: {formatTime(service.lastCheck)}</p>
      </div>
    </div>
  );
}
```

### Step 5: Implement Alerting System
```typescript
// src/services/AlertManager/index.ts
class AlertManager {
  private alerts: Map<string, Alert> = new Map();

  async checkThresholds() {
    // Check pending queue size
    const pendingCount = await prisma.txQueue.count({
      where: { status: 'pending' }
    });

    if (pendingCount > 100) {
      await this.createAlert({
        severity: 'warning',
        title: 'High pending queue',
        message: `${pendingCount} transactions pending`,
        service: 'ValidatorService'
      });
    }

    // Check error rate
    const errorRate = await this.calculateErrorRate();
    if (errorRate > 0.05) {
      await this.createAlert({
        severity: 'critical',
        title: 'High error rate',
        message: `Error rate: ${(errorRate * 100).toFixed(2)}%`,
        service: 'System'
      });
    }
  }

  async createAlert(alert: Alert) {
    // Store alert
    await prisma.alert.create({ data: alert });

    // Send notifications (email, Discord, etc.)
    await this.sendNotifications(alert);
  }
}
```

## Acceptance Criteria
- [ ] All services expose health endpoints
- [ ] Metrics collected every 10 seconds
- [ ] Dashboard shows real-time service status
- [ ] Historical metrics charts functional
- [ ] Alerting system triggers on thresholds
- [ ] Dashboard updates without refresh
- [ ] Mobile responsive design
- [ ] Export metrics to CSV
- [ ] Performance impact < 1% CPU

## Testing Requirements

### Unit Tests
1. Test metrics collection
2. Test health check logic
3. Test alert thresholds
4. Test data aggregation

### Integration Tests
1. Test full monitoring flow
2. Test dashboard data updates
3. Test alert notifications
4. Test metric persistence

### Performance Tests
1. Test with high metric volume
2. Test dashboard with 1000+ data points
3. Test concurrent metric writes
4. Measure monitoring overhead

## Database Changes
```sql
-- Create metrics table
CREATE TABLE "Metric" (
  "id" SERIAL PRIMARY KEY,
  "service" VARCHAR(255) NOT NULL,
  "type" VARCHAR(50) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "value" DECIMAL NOT NULL,
  "timestamp" TIMESTAMP NOT NULL,
  "tags" JSONB,
  INDEX idx_metric_service_timestamp (service, timestamp)
);

-- Create alerts table
CREATE TABLE "Alert" (
  "id" SERIAL PRIMARY KEY,
  "severity" VARCHAR(50) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "message" TEXT,
  "service" VARCHAR(255),
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP,
  "acknowledged_by" VARCHAR(255)
);
```

## Dependencies
- chart.js for visualization
- ws for WebSocket updates
- node-cron for scheduled checks

## Success Metrics
- 100% service visibility
- Alert response time < 2 minutes
- Dashboard load time < 2 seconds
- Zero missed critical alerts