/* eslint-env jest */
import { Readable } from 'node:stream'
import { _getEncryptor } from './_encryptor'
import crypto from 'crypto'

const algorithms = ['none', 'aes-256-cbc', 'aes-256-gcm']

function streamToBuffer(stream) {
  return new Promise(resolve => {
    const bufs = []
    stream.on('data', function (d) {
      bufs.push(d)
    })
    stream.on('end', function () {
      resolve(Buffer.concat(bufs))
    })
  })
}

algorithms.forEach(algorithm => {
  describe(`test algorithm ${algorithm}`, () => {
    const key = algorithm === 'none' ? undefined : '73c1838d7d8a6088ca2317fb5f29cd91'
    const encryptor = _getEncryptor(algorithm, key)
    const buffer = crypto.randomBytes(1024 * 1024 + 1)
    it('handle buffer', () => {
      const encrypted = encryptor.encryptData(buffer)
      if (algorithm !== 'none') {
        expect(encrypted.equals(buffer)).toEqual(false) // encrypted should be different
        // ivlength, auth tag, padding
        expect(encrypted.length).not.toEqual(buffer.length)
      }

      const decrypted = encryptor.decryptData(encrypted)
      expect(decrypted.equals(buffer)).toEqual(true)
    })

    it('handle stream', async () => {
      const stream = Readable.from(buffer)
      stream.length = buffer.length
      const encrypted = encryptor.encryptStream(stream)
      if (algorithm !== 'none') {
        expect(encrypted.length).toEqual(undefined)
      }

      const decrypted = encryptor.decryptStream(encrypted)
      const decryptedBuffer = await streamToBuffer(decrypted)
      expect(decryptedBuffer.equals(buffer)).toEqual(true)
    })
  })
})
