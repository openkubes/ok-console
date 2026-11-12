// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateLocalIdentityProfile, createLocalIdentityHttp } from './localIdentityHttp.mjs'
import { LocalIdentityClient } from '../cli/localIdentity.mjs'
const env = { OK_CONSOLE_LOCAL_IDENTITY_ENABLED:'true', OK_CONSOLE_PROFILE:'ok-local', NODE_ENV:'development', OK_CONSOLE_SESSION_STORE_MODE:'postgres', OK_CONSOLE_BFF_HOST:'127.0.0.1', OK_CONSOLE_ORIGIN:'https://127.0.0.1:8787' }
describe('OK-214 ordinary-local startup boundary', () => {
  it('requires opt-in and accepts only the explicit host-process profile', () => {
    expect(validateLocalIdentityProfile({})).toBe(false)
    expect(validateLocalIdentityProfile(env)).toBe(true)
  })
  it.each([
    {OK_CONSOLE_LOCAL_IDENTITY_ENABLED:'yes'}, {OK_CONSOLE_PROFILE:'production'}, {NODE_ENV:'production'}, {NODE_ENV:undefined},
    {OK_CONSOLE_SESSION_STORE_MODE:'disabled'}, {OK_CONSOLE_DEV_PROTOTYPE_ENABLED:'true'}, {OK_CONSOLE_BFF_HOST:'0.0.0.0'},
    {OK_CONSOLE_BFF_HOST:'localhost'}, {OK_CONSOLE_ORIGIN:'https://example.com'}, {OK_CONSOLE_ORIGIN:'http://127.0.0.1:8787'},
    {OK_CONSOLE_ORIGIN:'https://127.0.0.1:9999'}, {OK_CONSOLE_ORIGIN:'https://127.0.0.1:8787/path'},
    {KUBERNETES_SERVICE_HOST:'10.0.0.1'}, {OK_CONSOLE_BFF_ENABLE_FAILURE_INJECTION:'true'},
    {OK_CONSOLE_LOCAL_IDENTITY_RECOVERY_ENABLED:'true'},
  ])('rejects forbidden configuration even with a disposable-cluster acknowledgement: %j', (override) => {
    expect(()=>validateLocalIdentityProfile({...env,OK_CONSOLE_DISPOSABLE_LOCAL_CLUSTER_ACKNOWLEDGED:'true',...override})).toThrow()
  })
  it('never allows CLI plaintext, public endpoints or URL credential material', () => {
    for (const origin of ['http://127.0.0.1','https://example.com','https://name:password@127.0.0.1']) expect(()=>new LocalIdentityClient({origin})).toThrow()
  })
  it('checks Origin before reading mutation credentials and fails closed on session-store outage', async () => {
    let status
    const response={writeHead:(code)=>{status=code},end:()=>{}}
    const handler=createLocalIdentityHttp({identity:{},sessions:{resolve:async()=>{throw new Error('secret db detail')}},expectedOrigin:env.OK_CONSOLE_ORIGIN})
    await handler({request:{method:'POST',headers:{origin:'https://evil.example'}},response,pathname:'/api/console/v0/local-identity/create',correlationId:'test'})
    expect(status).toBe(403)
    await handler({request:{method:'GET',headers:{}},response,pathname:'/api/console/v0/local-identity/list',correlationId:'test'})
    expect(status).toBe(503)
  })
})

describe('ordinary throttle pool boundary', () => {
  it('rewrites pool and transaction queries, forwards listeners and releases errors', async () => {
    const { ordinaryThrottlePool } = await import('./localIdentity.mjs')
    const { EventEmitter } = await import('node:events')
    const calls = []
    const client = Object.assign(new EventEmitter(), {
      query: async (...args) => { calls.push(args); return {rows:[]} },
      release: (error) => { calls.push(['release',error]) },
    })
    const wrapped = ordinaryThrottlePool({query:client.query,connect:async()=>client})
    const sql = 'SELECT * FROM ok_console.local_access_throttle'
    await wrapped.query(sql,['pool'])
    const db = await wrapped.connect()
    await db.query(sql,['client'])
    expect(calls.slice(0,2)).toEqual([
      ['SELECT * FROM ok_identity.login_throttle',['pool']],
      ['SELECT * FROM ok_identity.login_throttle',['client']],
    ])
    const observed = []
    const listener = (error) => observed.push(error)
    db.on('error',listener)
    client.emit('error',Object.assign(new Error('private ok_identity.login_throttle'),{code:'42501',detail:'private SQL'}))
    expect(observed[0].code).toBe('42501')
    expect(JSON.stringify(observed)).not.toContain('private')
    expect(observed[0].message).not.toContain('ok_identity')
    expect(observed[0].cause).toBeUndefined()
    db.off('error',listener)
    expect(client.listenerCount('error')).toBe(0)
    db.on('error',listener)
    db.removeListener('error',listener)
    expect(client.listenerCount('error')).toBe(0)
    db.release(observed[0])
    expect(calls[2]).toEqual(['release',observed[0]])
  })
  it('sanitizes pool query and connection acquisition errors', async () => {
    // Real-driver error coverage lives in the PostgreSQL integration suite.
    const { ordinaryThrottlePool } = await import('./localIdentity.mjs')
    const error = Object.assign(new Error('private ok_identity.login_throttle'),{code:'42501',detail:'private SQL'})
    const fail = async () => { throw error }
    const wrapped = ordinaryThrottlePool({query:fail,connect:fail})
    for (const operation of [()=>wrapped.query('SELECT 1'),()=>wrapped.connect()]) {
      await expect(operation()).rejects.toMatchObject({message:'Ordinary login throttle operation failed.',code:'42501'})
      await expect(operation()).rejects.not.toHaveProperty('detail')
    }
  })
})
