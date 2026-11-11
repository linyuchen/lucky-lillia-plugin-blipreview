import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { PluginStorage } from '@luckylillia/plugin-sdk'
import { CredentialStore } from '../src/credentials.js'
import { Config } from '../src/config.js'

let dir: string
let storage: PluginStorage
const blank = { cookie: '', refreshToken: '' }
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blipreview-test-'))
  storage = { dir: async () => dir }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('keeps a command/QR login across restarts with unchanged form settings', async () => {
  const first = new CredentialStore(storage, 'default', blank)
  await first.save('SESSDATA=test%2Ccookie; bili_jct=csrf', 'refresh')
  const reloaded = new CredentialStore(storage, 'default', blank)
  expect(await reloaded.get()).toEqual({ cookie: 'SESSDATA=test%2Ccookie; bili_jct=csrf', refreshToken: 'refresh' })
  expect(await new CredentialStore(storage, 'default', Config({})).get()).toEqual(await reloaded.get())
  expect(await readdir(join(dir, 'accounts'))).toEqual(['default.json'])
})

it('imports changed form credentials but preserves command overrides until the form changes', async () => {
  const configured = { cookie: 'SESSDATA=form', refreshToken: 'form-token' }
  const first = new CredentialStore(storage, 'default', configured)
  await first.save('SESSDATA=command')
  expect(await new CredentialStore(storage, 'default', configured).get()).toEqual({ cookie: 'SESSDATA=command', refreshToken: '' })
  expect(await new CredentialStore(storage, 'default', { cookie: 'SESSDATA=new-form', refreshToken: '' }).get()).toEqual({ cookie: 'SESSDATA=new-form', refreshToken: '' })
  expect(await new CredentialStore(storage, 'default', blank).get()).toEqual(blank)
})

it('does not resurrect a cleared login or retain an unrelated refresh token', async () => {
  const configured = { cookie: 'SESSDATA=form', refreshToken: 'old' }
  const store = new CredentialStore(storage, 'default', configured)
  await store.save('SESSDATA=manual')
  expect((await store.get()).refreshToken).toBe('')
  await store.save('')
  expect(await new CredentialStore(storage, 'default', configured).get()).toEqual(blank)
})

it('clears an unsaved QR login from the form and keeps subsequent QR logins across reloads', async () => {
  const store = new CredentialStore(storage, 'default', Config({}))
  await store.save('SESSDATA=first-qr', 'first-refresh')
  const cleared = Config({ cookie: null, refreshToken: null, loginRevision: 'first-clear' })
  expect(cleared.cookie).toBeNull()
  expect(cleared.refreshToken).toBeNull()
  const afterClear = new CredentialStore(storage, 'default', cleared)
  expect(await afterClear.get()).toEqual(blank)
  await afterClear.save('SESSDATA=second-qr', 'second-refresh')
  expect(await new CredentialStore(storage, 'default', cleared).get()).toEqual({ cookie: 'SESSDATA=second-qr', refreshToken: 'second-refresh' })
  expect(await new CredentialStore(storage, 'default', Config({ cookie: null, refreshToken: null, loginRevision: 'second-clear' })).get()).toEqual(blank)
})

it('reimports an explicitly edited Cookie even when its text matches an older form value', async () => {
  const configured = Config({ cookie: 'SESSDATA=manual', refreshToken: 'manual-refresh', loginRevision: 'first-edit' })
  const store = new CredentialStore(storage, 'default', configured)
  await store.save('SESSDATA=qr', 'qr-refresh')
  const edited = Config({ ...configured, refreshToken: null, loginRevision: 'next-edit' })
  expect(await new CredentialStore(storage, 'default', edited).get()).toEqual({ cookie: 'SESSDATA=manual', refreshToken: '' })
})

it('isolates named accounts and reads deliberate sharing after another instance writes', async () => {
  const first = new CredentialStore(storage, 'shared', blank)
  await first.ready
  const other = new CredentialStore(storage, 'shared', blank)
  await other.ready
  await first.save('SESSDATA=shared')
  expect((await other.get()).cookie).toBe('SESSDATA=shared')
  expect(await new CredentialStore(storage, 'isolated', blank).get()).toEqual(blank)
  expect(() => new CredentialStore(storage, '../escape', blank)).toThrow()
})

it('writes valid complete records under concurrent saves and refuses cancelled updates', async () => {
  const store = new CredentialStore(storage, 'default', blank)
  await Promise.all([store.save('SESSDATA=one', 'one'), store.save('SESSDATA=two', 'two')])
  expect(JSON.parse(await readFile(join(dir, 'accounts/default.json'), 'utf8'))).toMatchObject({ cookie: 'SESSDATA=two', refreshToken: 'two' })
  await expect(store.save('SESSDATA=cancelled', '', AbortSignal.abort())).rejects.toThrow()
  expect((await store.get()).cookie).toBe('SESSDATA=two')
})
