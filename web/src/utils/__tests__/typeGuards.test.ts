// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
import { describe, it, expect } from 'vitest'
import {
  isReactionPayload,
  isEditPayload,
  isSilentPayload,
  isStoryReplyPayload,
  isStoryKeyPayload,
  isSystemMessagePayload,
  isPlainObject,
  isCiphertextWrapper
} from '../typeGuards'

// NOTE: type guards menerima OBJECT hasil JSON.parse, bukan string mentah.
const parse = (s: string) => JSON.parse(s)

describe('isReactionPayload', () => {
  it('menerima payload reaction valid', () => {
    expect(isReactionPayload(parse('{"type":"reaction","targetMessageId":"m1","emoji":"🔥"}'))).toBe(true)
  })
  it('menolak non-reaction', () => {
    expect(isReactionPayload(parse('{"type":"edit","targetMessageId":"m1","text":"x"}'))).toBe(false)
    expect(isReactionPayload(null)).toBe(false)
    expect(isReactionPayload('bukan objek')).toBe(false)
  })
})

describe('isEditPayload', () => {
  it('menerima edit valid & menolak lainnya', () => {
    expect(isEditPayload(parse('{"type":"edit","targetMessageId":"m1","text":"baru"}'))).toBe(true)
    expect(isEditPayload(parse('{"type":"reaction"}'))).toBe(false)
  })
})

describe('isSilentPayload', () => {
  it('mengenali tipe silent yang dikenal', () => {
    expect(isSilentPayload(parse('{"type":"CALL_INIT"}'))).toBe(true)
    expect(isSilentPayload(parse('{"type":"UNSEND","targetMessageId":"m1"}'))).toBe(true)
    expect(isSilentPayload(parse('{"type":"STORY_KEY"}'))).toBe(true)
  })
  it('menolak tipe tidak dikenal / non-objek', () => {
    expect(isSilentPayload(parse('{"type":"tidak-ada"}'))).toBe(false)
    expect(isSilentPayload('string')).toBe(false)
  })
  it('[T2] mengenali GROUP_KEY control payload dengan envelope groupKey', () => {
    const payload = parse('{"type":"GROUP_KEY","groupKey":{"key":"sealed-envelope","senderId":"AAAAAAAAAAAAAAAAAAAAAA","senderDeviceKey":"dev-key-b64","targetDeviceKey":"my-device-b64"}}')
    expect(isSilentPayload(payload)).toBe(true)
    if (isSilentPayload(payload)) {
      expect(payload.type).toBe('GROUP_KEY')
      expect(payload.groupKey?.key).toBe('sealed-envelope')
      expect(payload.groupKey?.targetDeviceKey).toBe('my-device-b64')
    }
  })
  it('[T2] GROUP_KEY tanpa groupKey tetap silent tapi tanpa envelope', () => {
    const payload = parse('{"type":"GROUP_KEY"}')
    expect(isSilentPayload(payload)).toBe(true)
    if (isSilentPayload(payload)) expect(payload.groupKey).toBeUndefined()
  })
})

describe('isStoryReplyPayload / isStoryKeyPayload', () => {
  it('story reply valid', () => {
    expect(isStoryReplyPayload(parse('{"type":"story_reply","storyAuthorId":"a","storyText":"hi"}'))).toBe(true)
    expect(isStoryReplyPayload(parse('{"type":"story"}'))).toBe(false)
  })
  it('story key valid', () => {
    expect(isStoryKeyPayload(parse('{"type":"STORY_KEY","storyId":"s1","key":"k"}'))).toBe(true)
  })
})

describe('isSystemMessagePayload', () => {
  it('mengenali payload sistem (objek dengan type string)', () => {
    expect(isSystemMessagePayload(parse('{"type":"SYSTEM_KEY_REQUEST"}'))).toBe(true)
    expect(isSystemMessagePayload(parse('{"type":"GROUP_KEY_DISTRIBUTION"}'))).toBe(true)
  })
  it('menolak non-objek', () => {
    expect(isSystemMessagePayload('halo')).toBe(false)
    expect(isSystemMessagePayload(null)).toBe(false)
  })
})

describe('isPlainObject / isCiphertextWrapper', () => {
  it('plain object vs non-object', () => {
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('str')).toBe(false)
  })
  it('ciphertext wrapper: objek tanpa ciphertext juga valid (optional)', () => {
    expect(isCiphertextWrapper({ header: {}, ciphertext: 'ct' })).toBe(true)
    expect(isCiphertextWrapper({ plaintext: 'x' })).toBe(true)
    expect(isCiphertextWrapper({ ciphertext: 123 })).toBe(false)
  })
})
