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
