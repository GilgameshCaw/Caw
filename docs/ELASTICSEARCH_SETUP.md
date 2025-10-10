# Elasticsearch Integration for CAW Protocol

## Overview

This document explains how Elasticsearch has been integrated into the CAW Protocol to provide scalable search and notification functionality.

## Benefits of Elasticsearch

1. **Performance**: Sub-second search across millions of documents
2. **Scalability**: Horizontal scaling through sharding
3. **Advanced Search**: Fuzzy matching, relevance scoring, and full-text search
4. **Aggregations**: Efficient grouping for notifications ("X and 24 others liked your post")
5. **Real-time**: Near real-time indexing and search

## Quick Start

### 1. Start Elasticsearch with Docker

```bash
# Start Elasticsearch and Kibana
docker-compose -f docker-compose.elasticsearch.yml up -d

# Check if Elasticsearch is running
curl http://localhost:9200/_cluster/health

# Access Kibana UI (optional)
open http://localhost:5601
```

### 2. Environment Variables

Add to your `.env` file:

```env
ELASTICSEARCH_NODE=http://localhost:9200
# Optional: Add API key if using authentication
# ELASTICSEARCH_API_KEY=your-api-key-here
```

### 3. Initialize and Sync Data

```bash
# The service auto-initializes on startup, but you can manually sync:
npm run es:sync
```

## Architecture

### Indices

1. **caws**: Stores all caw documents with content, hashtags, mentions
2. **notifications**: Stores notifications with grouping keys
3. **users**: Stores user profiles for search

### Data Flow

```
PostgreSQL (Source of Truth)
    ↓
Action Handlers / Services
    ↓
Elasticsearch (Search Index)
    ↓
API Routes (with fallback to PostgreSQL)
```

### Hybrid Approach

- **PostgreSQL**: Remains the source of truth for all data
- **Elasticsearch**: Used for search and aggregations
- **Fallback**: If ES is unavailable, system falls back to PostgreSQL

## Features Implemented

### 1. Search Enhancement

- **Fuzzy Search**: Handles typos and variations
- **Multi-field Search**: Searches across content, usernames, hashtags
- **Relevance Scoring**: Returns most relevant results first
- **Highlighting**: Shows matched terms in context

### 2. Notification Grouping

- **Efficient Aggregation**: Groups similar notifications at query time
- **Scalable**: Handles millions of notifications efficiently
- **Real-time Updates**: Near instant notification indexing

### 3. Trending Hashtags

- **Time-based Aggregations**: Get trending hashtags for any time range
- **Efficient Counting**: No database table scans required

## API Endpoints

All existing endpoints continue to work with ES enhancements:

- `GET /api/search`: Now uses ES with PostgreSQL fallback
- `GET /api/notifications`: Uses ES aggregations for grouping
- `GET /api/hashtags/trending`: Uses ES for efficient trending calculation

## Monitoring

### Check Elasticsearch Health

```bash
# Cluster health
curl http://localhost:9200/_cluster/health?pretty

# Index stats
curl http://localhost:9200/caws/_stats?pretty

# Count documents
curl http://localhost:9200/caws/_count?pretty
```

### Using Kibana

1. Open Kibana: http://localhost:5601
2. Go to Dev Tools
3. Run queries:

```json
// Search for caws
GET /caws/_search
{
  "query": {
    "match": {
      "content": "blockchain"
    }
  }
}

// Get trending hashtags
GET /caws/_search
{
  "size": 0,
  "aggs": {
    "trending": {
      "terms": {
        "field": "hashtags",
        "size": 10
      }
    }
  }
}
```

## Maintenance

### Reindex Data

If you need to rebuild the ES indices:

```bash
# Delete all indices
curl -X DELETE http://localhost:9200/caws
curl -X DELETE http://localhost:9200/notifications
curl -X DELETE http://localhost:9200/users

# Restart API to recreate indices
npm run api

# Run full sync
npm run es:sync
```

### Backup

```bash
# Create snapshot repository
curl -X PUT http://localhost:9200/_snapshot/backup -H 'Content-Type: application/json' -d '{
  "type": "fs",
  "settings": {
    "location": "/usr/share/elasticsearch/backup"
  }
}'

# Create snapshot
curl -X PUT http://localhost:9200/_snapshot/backup/snapshot_1?wait_for_completion=true
```

## Performance Tips

1. **Indexing**: Use bulk operations for large imports
2. **Searching**: Use filters instead of queries when possible
3. **Aggregations**: Limit bucket size for better performance
4. **Sharding**: Adjust shard count based on data volume

## Troubleshooting

### Elasticsearch Won't Start

```bash
# Check Docker logs
docker-compose -f docker-compose.elasticsearch.yml logs elasticsearch

# Common fix: Increase Docker memory allocation
```

### Slow Searches

1. Check index mapping: `curl http://localhost:9200/caws/_mapping?pretty`
2. Analyze query performance: Add `"profile": true` to search requests
3. Check cluster health: `curl http://localhost:9200/_cluster/health?pretty`

### Data Not Syncing

1. Check API logs for indexing errors
2. Verify ES connection: `curl http://localhost:9200`
3. Check index exists: `curl http://localhost:9200/_cat/indices?v`

## Future Enhancements

1. **Percolator Queries**: Real-time notification matching
2. **Machine Learning**: Anomaly detection for spam/abuse
3. **Geo Queries**: Location-based search
4. **Graph Exploration**: Social network analysis
5. **Vector Search**: Semantic search capabilities

## Resources

- [Elasticsearch Documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
- [Node.js Client](https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/index.html)
- [Query DSL](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl.html)