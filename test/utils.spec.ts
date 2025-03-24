import { base64ToObject, compareVersions, log, objectToBase64, retryWithExponentialBackoff, sanitizeString, sleep } from '../src/utils/general'
import { SecretEncryptor } from '../src/utils/secretEncryptor'
import * as crypto from 'crypto'


describe('SecretEncryptor', () => {
  it('should create an instance with a string key', () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    expect(encryptor).toBeInstanceOf(SecretEncryptor)
  })

  it('should create an instance with a Buffer key', () => {
    const key = crypto.randomBytes(32)
    const encryptor = new SecretEncryptor(key)
    expect(encryptor).toBeInstanceOf(SecretEncryptor)
  })

  it('should throw an error if Buffer key is not 32 bytes', () => {
    const key = crypto.randomBytes(16) // 16 bytes instead of 32
    expect(() => new SecretEncryptor(key)).toThrow('Key must be 32 bytes long for AES-256-GCM.')
  })

  it('should encrypt a plaintext string', () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const plaintext = 'This is a secret message'
    const encrypted = encryptor.encrypt(plaintext)

    // Encrypted format should be "iv:authTag:ciphertext"
    const parts = encrypted.split(':')
    expect(parts.length).toBe(3)

    // IV should be 12 bytes (24 hex chars)
    expect(parts[0].length).toBe(24)

    // Auth tag should be 16 bytes (32 hex chars)
    expect(parts[1].length).toBe(32)

    // Ciphertext should exist
    expect(parts[2].length).toBeGreaterThan(0)
  })

  it('should decrypt an encrypted string', () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const plaintext = 'This is a secret message'
    const encrypted = encryptor.encrypt(plaintext)
    const decrypted = encryptor.decrypt(encrypted)

    expect(decrypted).toBe(plaintext)
  })

  it('should handle empty strings for encryption and decryption', async () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const plaintext = ''
    const encrypted = encryptor.encrypt(plaintext)
    const decrypted = encryptor.decrypt(encrypted)

    expect(decrypted).toBe(plaintext)
  })

  it('should handle long text for encryption and decryption', async () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const plaintext = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam auctor, nisl eget ultricies aliquam, nunc nisl aliquet nunc, eget aliquam nisl nunc eget nisl. Nullam auctor, nisl eget ultricies aliquam, nunc nisl aliquet nunc, eget aliquam nisl nunc eget nisl.'.repeat(10)
    const encrypted = encryptor.encrypt(plaintext)
    const decrypted = encryptor.decrypt(encrypted)

    expect(decrypted).toBe(plaintext)
  })

  it('should throw an error when decrypting invalid format', () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const invalidData = 'invalid-data'

    expect(() => encryptor.decrypt(invalidData)).toThrow('Invalid encrypted data format.')
  })

  it('should throw an error when decrypting with wrong key', () => {
    const encryptor1 = new SecretEncryptor('correct-passphrase')
    const encryptor2 = new SecretEncryptor('wrong-passphrase')

    const plaintext = 'This is a secret message'
    const encrypted = encryptor1.encrypt(plaintext)

    expect(() => encryptor2.decrypt(encrypted)).toThrow()
  })

  it('should produce different ciphertexts for the same plaintext due to random IV', () => {
    const encryptor = new SecretEncryptor('my-secret-passphrase')
    const plaintext = 'This is a secret message'

    const encrypted1 = encryptor.encrypt(plaintext)
    const encrypted2 = encryptor.encrypt(plaintext)

    expect(encrypted1).not.toBe(encrypted2)
  })
})

describe('utils', () => {
  it('should log', () => {
    log({ level: 'info', msg: 'test' })
  })

  it('should sleep', async () => {
    await sleep(100)
  })

  it('should encode an object in base64', () => {
    const encoded = objectToBase64({key: 'string'})
    expect(encoded).toBe('eyJrZXkiOiJzdHJpbmcifQ==')
  })

  it('should decode an object from base64',  () => {
    const decoded = base64ToObject('eyJrZXkiOiJzdHJpbmcifQ==')
    expect(decoded).toEqual({key: 'string'})
  })

  it('should sanitize a string', () => {
    const sanitized = sanitizeString('test@#$%^&*()+=[]{}|;')
    expect(sanitized).toBe('test-----------------')
  })

  it('should retry a failed promise', async () => {
    let count = 1
    const failedPromise = async () => {
      count+=1
      await sleep(1000)
      if (count === 3) {
        return Promise.resolve('success')
      }
      return Promise.reject('failed')
    }
    
    const response = await retryWithExponentialBackoff(failedPromise, () => {}, 3, 750)
    expect(response).toBe('success')
    expect(count).toBe(3)
  })

  it('should retry a failed promise and fail', async () => {
    let count = 1
    const failedPromise = async () => {
      count+=1
      await sleep(1000)
      return Promise.reject('failed')
    }
    const response = await retryWithExponentialBackoff(failedPromise, () => {}, 3, 750)
      .catch((error) => {
        expect(error).toBe('failed')
      })
    expect(count).toBe(4)
  })
})

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.3.4', '2.3.4')).toBe(0)
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0)
  })

  it('should return -1 when first version is less than second (major version)', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
    expect(compareVersions('1.5.2', '2.0.0')).toBe(-1)
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1)
  })

  it('should return 1 when first version is greater than second (major version)', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1)
    expect(compareVersions('2.0.0', '1.5.2')).toBe(1)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
  })

  it('should return -1 when first version is less than second (minor version)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1)
    expect(compareVersions('1.4.2', '1.5.0')).toBe(-1)
    expect(compareVersions('2.0.0', '2.1.0')).toBe(-1)
  })

  it('should return 1 when first version is greater than second (minor version)', () => {
    expect(compareVersions('1.1.0', '1.0.0')).toBe(1)
    expect(compareVersions('1.5.0', '1.4.2')).toBe(1)
    expect(compareVersions('2.1.0', '2.0.0')).toBe(1)
  })

  it('should return -1 when first version is less than second (patch version)', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.1.2', '1.1.3')).toBe(-1)
    expect(compareVersions('2.2.4', '2.2.5')).toBe(-1)
  })

  it('should return 1 when first version is greater than second (patch version)', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersions('1.1.3', '1.1.2')).toBe(1)
    expect(compareVersions('2.2.5', '2.2.4')).toBe(1)
  })

  it('should handle versions with different length', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0')).toBe(0)
    expect(compareVersions('1.0.0', '1')).toBe(0)
    
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.1', '1.0')).toBe(1)
    expect(compareVersions('1.0.1', '1')).toBe(1)
  })

  it('should handle complex version comparisons', () => {
    expect(compareVersions('1.2.3', '1.2.3.4')).toBe(-1)
    expect(compareVersions('1.2.3.4', '1.2.3')).toBe(1)
    expect(compareVersions('10.2.3', '2.10.3')).toBe(1)
    expect(compareVersions('0.10.0', '0.2.0')).toBe(1)
  })
})
