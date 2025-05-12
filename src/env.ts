import dotenv from 'dotenv'

dotenv.config()

export const env = {
  DEBUG: /true/i.test(process.env.DEBUG || 'false'),
  PORT: process.env.PORT || 8080,
  MONGO_USER: process.env.MONGO_USER || 'root',
  MONGO_PASS: process.env.MONGO_PASS || 'example',
  MONGO_HOST: process.env.MONGO_HOST || 'localhost:27017',
  MONGO_DBNAME: process.env.MONGO_DBNAME || 'squad-test',
  MONGO_REPLICASET: process.env.MONGO_REPLICASET || undefined,
  PAYLOAD_LIMIT: process.env.PAYLOAD_LIMIT || '6mb',
  SECRETS_KEY: process.env.SECRETS_KEY || 'secret',
  SECRETS_DBNAME: process.env.SECRETS_DBNAME || 'secrets',
  INSTALL_ON_START: (process.env.INSTALL_ON_START || '@missionsquad/mcp-github|github,@missionsquad/mcp-helper-tools|helper-tools').split(',').map((pkg) => {
    const [repo, name] = pkg.split('|')
    return { repo, name }
  })
}