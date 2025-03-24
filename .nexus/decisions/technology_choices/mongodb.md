# Technology Choice: MongoDB

## Context
MCP API requires a database solution for storing server configurations, package information, and encrypted secrets. The choice of database affects data modeling, query performance, scalability, and operational complexity.

## Decision
MongoDB was chosen as the database solution for the MCP API project.

## Rationale

### Document-Oriented Data Model
MongoDB's document-oriented data model provides several benefits:

1. **Schema Flexibility** - Documents can have different structures, allowing for easy evolution
2. **JSON-like Documents** - Natural fit for JavaScript/TypeScript applications
3. **Nested Data Structures** - Can represent complex hierarchical data without joins
4. **No ORM Required** - Direct mapping between application objects and database documents

```typescript
// Example of MongoDB document structures in MCP API
interface MCPServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  enabled: boolean;
  errors?: string[];
  // ...
}

interface PackageInfo {
  name: string;
  version: string;
  installPath: string;
  main?: string;
  status: 'installed' | 'installing' | 'error';
  installed: Date;
  lastUsed?: Date;
  error?: string;
  mcpServerId?: string;
  enabled?: boolean;
}

interface UserSecret {
  username: string;
  server: string;
  key: string;
  value: string; // Encrypted value
}
```

### Query Capabilities
MongoDB provides powerful query capabilities:

1. **Rich Query Language** - Supports complex queries, filtering, and aggregation
2. **Indexing** - Supports various index types for query optimization
3. **Text Search** - Built-in text search capabilities
4. **Aggregation Framework** - Powerful data transformation and analysis

```typescript
// Example of MongoDB queries in MCP API
async find(filter: Filter<T>, sort?: Sort, limit?: number): Promise<Array<WithId<T>>> {
  return this.collection.find(filter, { sort, limit }).toArray()
}

async findOne(filter: Filter<T>, sort?: Sort): Promise<T | null> {
  const result = await this.collection.findOne(filter, { sort })
  if (result != null) {
    const { _id, ...item } = result as any
    return item as T
  } else {
    return null
  }
}
```

### Performance and Scalability
MongoDB offers good performance and scalability characteristics:

1. **Horizontal Scaling** - Supports sharding for distributing data across multiple servers
2. **Replication** - Built-in replication for high availability
3. **Memory-Mapped Storage** - Efficient use of system memory for caching
4. **Indexing** - Various index types for query optimization

### TypeScript Integration
MongoDB works well with TypeScript:

1. **Type Definitions** - Official type definitions available
2. **Generic Client** - The MongoDB client can be typed with generic types
3. **Type-Safe Queries** - Type-safe query construction and results

```typescript
// Example of TypeScript integration with MongoDB in MCP API
export class MongoDBClient<T extends Document> {
  private url: string
  private dbName: string
  private collectionName!: string
  private client: MongoClient
  private db!: Db
  private collection!: Collection<T>
  private indexes: IndexDefinition[]

  // ...

  async find(filter: Filter<T>, sort?: Sort, limit?: number): Promise<Array<WithId<T>>> {
    return this.collection.find(filter, { sort, limit }).toArray()
  }

  async findOne(filter: Filter<T>, sort?: Sort): Promise<T | null> {
    const result = await this.collection.findOne(filter, { sort })
    if (result != null) {
      const { _id, ...item } = result as any
      return item as T
    } else {
      return null
    }
  }
}
```

### Operational Simplicity
MongoDB offers operational simplicity:

1. **Easy Setup** - Simple to set up and configure
2. **Minimal Administration** - Requires less administration than traditional RDBMSs
3. **Cloud Options** - Available as a managed service (MongoDB Atlas)
4. **Docker Support** - Works well in containerized environments

## Implementation Details

### Connection Management

The MCP API uses a custom `MongoDBClient` class for managing MongoDB connections:

```typescript
export class MongoDBClient<T extends Document> {
  private url: string
  private dbName: string
  private collectionName!: string
  private client: MongoClient
  private db!: Db
  private collection!: Collection<T>
  private indexes: IndexDefinition[]

  constructor(
    {
      host,
      db,
      user,
      pass,
      authDB
    }: MongoConnectionParams,
    indexes: IndexDefinition[] = []
  ) {
    this.url = `mongodb://${host}`
    this.dbName = db
    const options: MongoClientOptions = {
      auth: {
        username: user,
        password: pass
      }
    }
    if (authDB) {
      options.authSource = authDB
    }
    this.client = new MongoClient(this.url, options)
    this.indexes = indexes
  }

  async connect(collectionName: string): Promise<void> {
    this.collectionName = collectionName
    log({ level: 'debug', msg: `Connecting to MongoDB collection: ${collectionName}...` })
    await this.client.connect().catch((error) => log({ level: 'error', msg: 'Failed to connect to MongoDB', error }))
    this.db = this.client.db(this.dbName)
    const collections = await this.db.listCollections().toArray()
    const collectionNames = collections.map(({ name }) => name)
    if (!collectionNames.includes(collectionName)) {
      this.collection = await this.db.createCollection<T>(collectionName)
      log({ level: 'info', msg: `Created collection: ${collectionName}` })
    } else {
      this.collection = this.db.collection<T>(collectionName)
    }
    const indexes = await this.collection.indexes()
    const indexMaps = indexes.map(({ key }) => objectMapString(key))
    for (const { name, key } of this.indexes) {
      const indexMap = objectMapString(key)
      if (!indexMaps.includes(indexMap)) {
        await this.collection.createIndexes([{ name, key }])
        log({ level: 'info', msg: `Created index ${name}` })
      }
    }
    log({ level: 'info', msg: `Connected to MongoDB collection: ${collectionName}` })
  }

  async disconnect(): Promise<void> {
    await this.client.close()
    log({ level: 'info', msg: `Disconnected from ${this.dbName} : ${this.collectionName}` })
  }
}
```

### Data Collections

The MCP API uses several MongoDB collections:

1. **mcp** - Stores MCP server configurations
2. **packages** - Stores package information
3. **appState** - Stores application state information
4. **secrets** - Stores encrypted user secrets

### Indexing Strategy

Each collection has a set of indexes defined to optimize query performance:

```typescript
const mcpIndexes: IndexDefinition[] = [
  { name: 'name', key: { name: 1 } }
]

const packageIndexes: IndexDefinition[] = [
  { name: 'name', key: { name: 1 } }
]

const appStateIndexes: IndexDefinition[] = [
  { name: 'firstRunCompleted', key: { firstRunCompleted: 1 } }
]

const userSecretIndexes: IndexDefinition[] = [
  { name: 'username', key: { username: 1 } },
  { name: 'key', key: { key: 1 } },
  { name: 'username_key', key: { username: 1, key: 1 } }
]
```

### CRUD Operations

The `MongoDBClient` class provides a generic interface for CRUD operations:

```typescript
async insert(
  items: Array<OptionalUnlessRequiredId<T>> | OptionalUnlessRequiredId<T>
): Promise<InsertOneResult<T> | InsertManyResult<T>> {
  if (Array.isArray(items)) {
    return this.collection.insertMany(items)
  } else {
    return this.collection.insertOne(items)
  }
}

async update(item: Partial<T> | T, filter: Filter<T>): Promise<UpdateResult<T>> {
  return this.collection.updateOne(filter, { $set: item })
}

async upsert(item: Partial<T> | T, filter: Filter<T>): Promise<UpdateResult<T>> {
  return this.collection.updateOne(filter, { $set: item }, { upsert: true })
}

async find(filter: Filter<T>, sort?: Sort, limit?: number): Promise<Array<WithId<T>>> {
  return this.collection.find(filter, { sort, limit }).toArray()
}

async findOne(filter: Filter<T>, sort?: Sort): Promise<T | null> {
  const result = await this.collection.findOne(filter, { sort })
  if (result != null) {
    const { _id, ...item } = result as any
    return item as T
  } else {
    return null
  }
}

async delete(filter: Filter<T>, many: boolean = true): Promise<DeleteResult> {
  if (many) {
    return this.collection.deleteMany(filter)
  } else {
    return this.collection.deleteOne(filter)
  }
}
```

## Alternatives Considered

### PostgreSQL
- **Pros**: ACID compliance, robust relational model, mature ecosystem
- **Cons**: Less flexible schema, more complex setup, requires ORM for TypeScript integration

### Redis
- **Pros**: In-memory performance, simple key-value model, pub/sub capabilities
- **Cons**: Limited query capabilities, less suitable for complex data, persistence limitations

### SQLite
- **Pros**: Zero configuration, file-based, ACID compliant
- **Cons**: Limited concurrency, not suitable for distributed systems, less scalable

### DynamoDB
- **Pros**: Fully managed, highly scalable, predictable performance
- **Cons**: AWS-specific, less flexible querying, potentially higher cost

## Considerations/Open Questions

- How to handle MongoDB schema migrations as the application evolves?
- Should we implement connection pooling for better performance?
- How to handle MongoDB replica sets and sharding for production deployments?
- Should we implement a caching layer for frequently accessed data?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [MongoDB Integration Architecture](../architecture/mongodb_integration.md)
- [Secure Secret Management Feature](../features/secure_secret_management.md)
- [TypeScript Technology Choice](./typescript.md)
