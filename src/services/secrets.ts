import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'

export interface UserSecret {
  username: string
  server: string
  key: string
  value: string
}
const userSecretIndexes: IndexDefinition[] = [
  { name: 'username', key: { username: 1 } },
  { name: 'key', key: { key: 1 } },
  { name: 'username_key', key: { username: 1, key: 1 } }
]

export class Secrets {
  private secrets: SecretEncryptor
  private secretsDBClient: MongoDBClient<UserSecret>

  constructor({
    mongoParams
  }: {
    mongoParams: MongoConnectionParams
  }) {
    this.secrets = new SecretEncryptor(env.SECRETS_KEY)
    this.secretsDBClient = new MongoDBClient<UserSecret>(mongoParams, userSecretIndexes)
  }

  public async init() {
    await this.secretsDBClient.connect(env.SECRETS_DBNAME)
  }

  public async getSecrets(username: string, server: string) {
    console.log(`get secrets for user ${username}`)
    if (this.secretsDBClient == null) {
      throw new Error('secretsDBClient is not initialized')
    }
    const userSecrets = await this.secretsDBClient.find({ username, server })
    // { 'mcp-server-name': { 'secretName': 'secretValue' } }
    const secrets: Record<string, Record<string, string>> = userSecrets.reduce((acc, secret) => {
      const decryptedSecretValue = this.secrets.decrypt(secret.value)
      if (acc[secret.server] == null) {
        acc[secret.server] = {}
      }
      acc[secret.server][secret.key] = decryptedSecretValue
      return acc
    }, {} as Record<string, Record<string, string>>)
    return secrets
  }

  public async updateSecret({
    username,
    serverName,
    secretName,
    secretValue,
    action
  }: {
    username: string
    serverName: string
    secretName: string
    secretValue: string
    action: 'save' | 'update' | 'delete'
  }) {
    if (!secretName || !secretValue || !action) {
      return false
    }

    switch (action) {
      case 'delete':
        await this.secretsDBClient.delete({ username, server: serverName, key: secretName })
        break
      case 'save':
      case 'update':
        const encryptedSecretValue = this.secrets.encrypt(secretValue)
        await this.secretsDBClient.upsert({
          username,
          server: serverName,
          key: secretName,
          value: encryptedSecretValue
        }, {
          username,
          server: serverName,
          key: secretName
        })
        break
      default:
        return false
    }
    return true
  }
}
