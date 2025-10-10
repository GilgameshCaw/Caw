# Story: Add Database Migration System

## Story ID: SPRINT1-003
## Priority: MEDIUM
## Estimated Points: 3
## Agent: Backend Dev & DevOps

## Context
The project currently lacks a robust database migration system, making it difficult to manage schema changes across environments. We need to implement proper migration tracking and rollback capabilities.

### Current Issues
- Manual schema updates prone to errors
- No version tracking for database changes
- Difficult to sync development and production schemas
- No rollback mechanism for failed migrations

### Related Components
- `/client/prisma/schema.prisma` - Database schema
- `/client/prisma/migrations/` - Migration files
- Database: PostgreSQL

## Implementation Details

### Step 1: Set Up Migration Infrastructure
```bash
# Initialize Prisma migrations
npx prisma migrate dev --name init

# Create migration for retry tracking
npx prisma migrate dev --name add_retry_tracking
```

### Step 2: Add Migration Scripts
```json
// package.json
{
  "scripts": {
    "db:migrate": "prisma migrate deploy",
    "db:migrate:dev": "prisma migrate dev",
    "db:migrate:reset": "prisma migrate reset",
    "db:migrate:status": "prisma migrate status",
    "db:seed": "prisma db seed",
    "db:studio": "prisma studio"
  }
}
```

### Step 3: Create Custom Migration Runner
```typescript
// scripts/migrate.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class MigrationRunner {
  async run() {
    console.log('Starting database migration...');

    try {
      // Check current migration status
      const { stdout: status } = await execAsync('npx prisma migrate status');
      console.log('Current status:', status);

      // Run pending migrations
      const { stdout: result } = await execAsync('npx prisma migrate deploy');
      console.log('Migration result:', result);

      // Verify schema
      await this.verifySchema();

      console.log('Migration completed successfully');
    } catch (error) {
      console.error('Migration failed:', error);
      await this.rollback();
      process.exit(1);
    }
  }

  async verifySchema() {
    // Run schema validation
    const { stdout } = await execAsync('npx prisma validate');
    console.log('Schema validation:', stdout);
  }

  async rollback() {
    console.log('Rolling back migration...');
    // Implement rollback logic
  }
}
```

### Step 4: Add Migration Tracking
```sql
-- Create migration history tracking
CREATE TABLE IF NOT EXISTS "_MigrationHistory" (
  "id" SERIAL PRIMARY KEY,
  "migration_name" VARCHAR(255) NOT NULL UNIQUE,
  "applied_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "checksum" VARCHAR(64),
  "applied_by" VARCHAR(255),
  "execution_time_ms" INTEGER
);
```

### Step 5: Implement Safe Migration Process
```typescript
// scripts/safeMigrate.ts
class SafeMigration {
  async migrate() {
    // 1. Backup current schema
    await this.backupDatabase();

    // 2. Run migrations in transaction
    await prisma.$transaction(async (tx) => {
      // Apply migrations
      await this.applyMigrations(tx);

      // Verify data integrity
      await this.verifyDataIntegrity(tx);
    });

    // 3. Run post-migration checks
    await this.postMigrationChecks();
  }

  async backupDatabase() {
    const timestamp = new Date().toISOString();
    const backupFile = `backup_${timestamp}.sql`;

    await execAsync(`pg_dump $DATABASE_URL > ${backupFile}`);
    console.log(`Backup created: ${backupFile}`);
  }

  async verifyDataIntegrity(tx: any) {
    // Check foreign key constraints
    // Verify data consistency
    // Ensure no data loss
  }
}
```

### Step 6: Create Migration Templates
```typescript
// templates/migration.template.ts
export const migrationTemplate = `
-- Migration: {MIGRATION_NAME}
-- Date: {DATE}
-- Author: {AUTHOR}

-- UP Migration
{UP_SCRIPT}

-- DOWN Migration (Rollback)
{DOWN_SCRIPT}
`;
```

## Acceptance Criteria
- [ ] Prisma migrations properly configured
- [ ] Migration scripts in package.json
- [ ] Custom migration runner implemented
- [ ] Database backup before migrations
- [ ] Migration history tracked
- [ ] Rollback mechanism functional
- [ ] Schema validation after migration
- [ ] Documentation updated
- [ ] CI/CD pipeline includes migrations

## Testing Requirements

### Unit Tests
1. Test migration runner logic
2. Test backup creation
3. Test rollback functionality
4. Test schema validation

### Integration Tests
1. Test full migration cycle
2. Test rollback scenarios
3. Test concurrent migrations
4. Test migration with data

### Migration Testing
1. Test on copy of production data
2. Verify no data loss
3. Test rollback and re-apply
4. Performance impact assessment

## Database Changes
```sql
-- Add retry tracking to TxQueue
ALTER TABLE "TxQueue"
ADD COLUMN IF NOT EXISTS "retry_count" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "last_retry_at" TIMESTAMP,
ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS "idx_txqueue_status_next_retry"
ON "TxQueue" ("status", "next_retry_at");

-- Add migration metadata
ALTER TABLE "TxQueue"
ADD COLUMN IF NOT EXISTS "created_by_migration" VARCHAR(255);
```

## Dependencies
- Prisma CLI (already installed)
- pg_dump for backups
- No additional packages needed

## Monitoring & Alerts
- Alert on migration failure
- Track migration execution time
- Monitor schema drift
- Alert on rollback execution

## Rollback Plan
1. Restore from backup
2. Run down migrations
3. Verify data integrity
4. Update migration history

## Success Metrics
- Zero failed migrations in production
- Migration execution < 60 seconds
- 100% successful rollbacks when needed
- No data loss incidents