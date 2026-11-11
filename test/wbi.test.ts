import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { signWbi, WbiSigner } from '../src/wbi.js'
import { WBI } from './fixtures.js'

const img = '7cd084941338484aae1ad9425b84077c'
const sub = '4932caff0ff746eab6f01bf08b70ac45'

it('matches a fixed WBI vector for the canonical bar/baz/foo/wts query', () => {
  expect(signWbi({ foo: '114', bar: '514', baz: '1919810' }, img, sub, 1702204169)).toEqual({
    bar: '514', baz: '1919810', foo: '114', wts: '1702204169', w_rid: '6149fdadf571698ca7e6a567265cd0ee',
  })
})

it('encodes title spaces as %20 and filters WBI punctuation before hashing', () => {
  const signed = signWbi({ keyword: "a b&c!'()*" }, img, sub, 1702204169)
  expect(signed.keyword).toBe('a b&c')
  expect(signed.w_rid).toBe(createHash('md5').update('keyword=a%20b%26c&wts=1702204169ea1db124af3c7062474693fa704f4ff8').digest('hex'))
})

it('shares in-flight key requests inside an instance, without sharing another account cache', async () => {
  let calls = 0
  const signer = new WbiSigner(async () => { calls++; return WBI })
  await Promise.all([signer.sign({ aid: 1 }), signer.sign({ cid: 2 })])
  await signer.sign({ aid: 3 })
  expect(calls).toBe(1)
  const second = new WbiSigner(async () => { calls++; return WBI })
  await second.sign({ aid: 1 })
  expect(calls).toBe(2)
})
