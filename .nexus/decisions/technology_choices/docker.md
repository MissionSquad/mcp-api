# Technology Choice: Docker

## Context
MCP API requires a consistent, reproducible deployment environment that can be easily set up across different development and production environments. The choice of containerization technology affects deployment consistency, scalability, and operational complexity.

## Decision
Docker was chosen as the containerization technology for the MCP API project.

## Rationale

### Containerization Benefits
Docker provides several benefits through containerization:

1. **Environment Consistency** - Ensures the same environment across development, testing, and production
2. **Isolation** - Isolates the application and its dependencies from the host system
3. **Resource Efficiency** - More efficient than virtual machines, with minimal overhead
4. **Portability** - Runs consistently across different platforms and cloud providers

```dockerfile
# Example of Dockerfile in MCP API
FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

EXPOSE 8080

CMD ["node", "--experimental-require-module", "dist/index.js"]
```

### Docker Compose Integration
Docker Compose simplifies multi-container deployments:

1. **Service Orchestration** - Manages multiple containers as a single application
2. **Environment Variables** - Easy configuration through environment variables
3. **Volume Mounting** - Persistent storage for databases and configuration
4. **Network Configuration** - Simplified networking between containers

```yaml
# Example of docker-compose.yml in MCP API
version: '3'

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - MONGO_USER=root
      - MONGO_PASS=example
      - MONGO_HOST=mongo:27017
      - MONGO_DBNAME=mcp
      - SECRETS_KEY=${SECRETS_KEY}
    depends_on:
      - mongo
    volumes:
      - ./packages:/app/packages

  mongo:
    image: mongo:latest
    environment:
      - MONGO_INITDB_ROOT_USERNAME=root
      - MONGO_INITDB_ROOT_PASSWORD=example
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

### Development Workflow
Docker enhances the development workflow:

1. **Consistent Development Environment** - Ensures all developers work in the same environment
2. **Quick Setup** - New developers can get started quickly with a simple `docker-compose up`
3. **Isolation** - Prevents conflicts with other projects or system dependencies
4. **Easy Testing** - Simplifies testing in isolated environments

### Production Deployment
Docker simplifies production deployment:

1. **Immutable Infrastructure** - Containers are immutable, ensuring consistency
2. **Scalability** - Easy to scale horizontally by adding more container instances
3. **Orchestration** - Works well with orchestration platforms like Kubernetes
4. **CI/CD Integration** - Integrates well with continuous integration and deployment pipelines

## Implementation Details

### Dockerfile

The MCP API uses a multi-stage Dockerfile for efficient builds:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

EXPOSE 8080

CMD ["node", "--experimental-require-module", "dist/index.js"]
```

### Docker Compose Configuration

The MCP API uses Docker Compose for local development and simple deployments:

```yaml
version: '3'

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - MONGO_USER=root
      - MONGO_PASS=example
      - MONGO_HOST=mongo:27017
      - MONGO_DBNAME=mcp
      - SECRETS_KEY=${SECRETS_KEY}
    depends_on:
      - mongo
    volumes:
      - ./packages:/app/packages

  mongo:
    image: mongo:latest
    environment:
      - MONGO_INITDB_ROOT_USERNAME=root
      - MONGO_INITDB_ROOT_PASSWORD=example
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
```

### Environment Configuration

The MCP API uses environment variables for configuration, which works well with Docker:

```typescript
// In env.ts
export const env = {
  DEBUG: /true/i.test(process.env.DEBUG || 'false'),
  PORT: process.env.PORT || 8080,
  MONGO_USER: process.env.MONGO_USER || 'root',
  MONGO_PASS: process.env.MONGO_PASS || 'example',
  MONGO_HOST: process.env.MONGO_HOST || 'localhost:27017',
  MONGO_DBNAME: process.env.MONGO_DBNAME || 'squad-test',
  PAYLOAD_LIMIT: process.env.PAYLOAD_LIMIT || '6mb',
  SECRETS_KEY: process.env.SECRETS_KEY || 'secret',
  SECRETS_DBNAME: process.env.SECRETS_DBNAME || 'secrets',
  INSTALL_ON_START: (process.env.INSTALL_ON_START || '@missionsquad/mcp-github|github,@missionsquad/mcp-helper-tools|helper-tools').split(',').map((pkg) => {
    const [repo, name] = pkg.split('|')
    return { repo, name }
  })
}
```

### Volume Management

The MCP API uses Docker volumes for persistent data:

1. **MongoDB Data** - Stores MongoDB data in a named volume
2. **Packages Directory** - Mounts the packages directory as a volume for persistence

```yaml
volumes:
  - ./packages:/app/packages  # Bind mount for packages
  - mongo-data:/data/db       # Named volume for MongoDB data
```

## Alternatives Considered

### Virtual Machines
- **Pros**: Complete isolation, full OS control
- **Cons**: Higher resource overhead, slower startup, more complex management

### Serverless Deployment
- **Pros**: No infrastructure management, automatic scaling
- **Cons**: Cold start latency, limited execution time, potential vendor lock-in

### Native Installation
- **Pros**: No containerization overhead, simpler setup
- **Cons**: Environment inconsistency, dependency conflicts, more complex deployment

## Considerations/Open Questions

- How to handle MCP server processes within Docker containers?
- Should we implement a more robust orchestration solution (e.g., Kubernetes) for production?
- How to handle Docker image versioning and tagging?
- Should we implement a more sophisticated CI/CD pipeline for Docker image building and deployment?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [MongoDB Technology Choice](./mongodb.md)
- [Package Management Feature](../features/package_management.md)
