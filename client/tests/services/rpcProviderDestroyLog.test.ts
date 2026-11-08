/**
 * The warning logged when a provider's destroy() is called must not print the
 * provider's URL as is: many RPC providers put an API key in it. Only the
 * redacted form (redactRpcUrl) may appear.
 */
import { afterEach } from 'mocha'
import { expect } from 'chai'
import { makeJsonRpcProvider } from '../../src/utils/rpcProvider'

describe('rpcProvider destroy() warning', () => {
  const realWarn = console.warn
  afterEach(() => {
    console.warn = realWarn
  })

  function destroyAndCapture(url: string): string {
    const lines: string[] = []
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    const provider = makeJsonRpcProvider(url, 11155111)
    provider.destroy()
    console.warn = realWarn
    const line = lines.find((l) => l.includes('destroy() called'))
    expect(line, 'expected a destroy() warning').to.be.a('string')
    return line as string
  }

  it('does not print the API key of a /v3/<key> URL', () => {
    const line = destroyAndCapture('https://sepolia.infura.io/v3/SECRETKEY0123456789')
    expect(line).to.include('url=https://sepolia.infura.io/v3/')
    expect(line).to.not.include('SECRETKEY0123456789')
  })

  it('does not print Basic auth credentials embedded in the URL', () => {
    const line = destroyAndCapture('https://user:SECRETPASS0123456789@rpc.example.org/')
    expect(line).to.include('url=https://rpc.example.org')
    expect(line).to.not.include('SECRETPASS0123456789')
  })

  it('still shows the host of a URL that carries no key', () => {
    const line = destroyAndCapture('https://ethereum-sepolia-rpc.publicnode.com')
    expect(line).to.include('url=https://ethereum-sepolia-rpc.publicnode.com')
  })
})
