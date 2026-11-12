// @vitest-environment node
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync, execFile } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import { createServer } from 'node:net'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SessionEnvelopeCodec } from './envelope.mjs'
import { PostgresSessionStore } from './postgresSessionStore.mjs'
import { PostgresLocalAccessThrottle } from './localAccess.mjs'
import { LocalIdentity, ordinaryThrottlePool } from './localIdentity.mjs'
import { createSessionRuntime } from './runtime.mjs'
import { createConsoleServer } from '../server.mjs'
import { LocalIdentityClient } from '../cli/localIdentity.mjs'

const url = process.env.OK_CONSOLE_TEST_POSTGRES_URL
const suite = url ? describe : describe.skip
const password = 'Disposable test credential 214!'
const scope = { environmentId: 'community-preview', tenantIds: ['platform'] }
const bootstrap = { subject: { id: 'named-bootstrap', method: 'Bootstrap' }, scope, permissions: ['local.users.initialize','local.users.recover'], authorizationRevision: 'mapping-1' }

suite('OK-214 real PostgreSQL local identity', () => {
  let pool, sessions, identity, directory, runtime, origin, ca, env
  const cookieHeader = (client) => [...client.cookies].map(([k,v]) => `${k}=${v}`).join('; ')
  const client = () => new LocalIdentityClient({ origin, ca })
  const login = async (name) => { const c = client(); await c.request('/api/console/v0/local-identity/login', { username: name, password }); return c }
  const init = () => identity.manage('initialize', bootstrap, { username: 'admin-one', password }, 'test-init')
  const adminContext = async () => { const issued = await identity.login({ username: 'admin-one', password }, 'test-login'); return sessions.resolve(issued.cookie) }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 })
    for (const file of ['001_console_sessions','002_oidc_transactions','003_local_access_throttle','004_local_access_audit','005_local_identity']) {
      await pool.query(await readFile(new URL(`./postgres/${file}.sql`, import.meta.url), 'utf8'))
    }
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ok214_identity_owner') THEN CREATE ROLE ok214_identity_owner NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='ok214_runtime') THEN CREATE ROLE ok214_runtime LOGIN PASSWORD 'disposable-runtime-only'; END IF;
    END $$;
    ALTER SCHEMA ok_identity OWNER TO ok214_identity_owner;
    ALTER TABLE ok_identity.accounts OWNER TO ok214_identity_owner;
    ALTER TABLE ok_identity.state OWNER TO ok214_identity_owner;
    ALTER TABLE ok_identity.audit OWNER TO ok214_identity_owner;
    ALTER TABLE ok_identity.login_throttle OWNER TO ok214_identity_owner;
    GRANT USAGE ON SCHEMA ok_console,ok_identity TO ok214_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ok_console.sessions,ok_console.oidc_transactions,ok_console.local_access_throttle,ok_identity.login_throttle TO ok214_runtime;
    GRANT SELECT,INSERT,UPDATE ON ok_identity.accounts TO ok214_runtime;
    GRANT SELECT,UPDATE ON ok_identity.state TO ok214_runtime;
    GRANT INSERT ON ok_identity.audit,ok_console.authentication_audit,ok_console.local_access_audit TO ok214_runtime;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA ok_console,ok_identity TO ok214_runtime;`)
    sessions = new PostgresSessionStore({ pool, codec: new SessionEnvelopeCodec({ primaryKeyId: 'test-key', keys: { 'test-key': Buffer.alloc(32,1) } }), deploymentEpoch: 'test-epoch', authorizationRevisionValidator: async () => true })
    identity = new LocalIdentity({ pool, sessions, throttle: new PostgresLocalAccessThrottle({ pool: ordinaryThrottlePool(pool), pepper: Buffer.alloc(32,2) }), scope, authorizationRevision: 'mapping-1', recoveryEnabled: true })
    sessions.contextValidator = (context, db) => identity.current(context, db)
    directory = await mkdtemp(`${tmpdir()}/ok214-`)
    const put = async (name, value) => { const path = `${directory}/${name}`; await writeFile(path,value,{ mode: 0o600 }); return path }
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',`${directory}/key.pem`,'-out',`${directory}/cert.pem`],{ stdio: 'ignore' })
    ca = await readFile(`${directory}/cert.pem`)
    const port = await new Promise((resolve) => { const s = createServer(); s.listen(0,'127.0.0.1',()=> { const p=s.address().port; s.close(()=>resolve(p)) }) })
    origin = `https://127.0.0.1:${port}`
    const salt = Buffer.alloc(16,5)
    const runtimeUrl=new URL(url); runtimeUrl.username='ok214_runtime'; runtimeUrl.password='disposable-runtime-only'
    env = {
      OK_CONSOLE_LOCAL_IDENTITY_ENABLED:'true', OK_CONSOLE_PROFILE:'ok-local', NODE_ENV:'development',
      OK_CONSOLE_SESSION_STORE_MODE:'postgres', OK_CONSOLE_BFF_HOST:'127.0.0.1', OK_CONSOLE_BFF_PORT:String(port), OK_CONSOLE_ORIGIN:origin,
      OK_CONSOLE_ENVIRONMENT_ID:scope.environmentId, OK_CONSOLE_TENANT_ID:'platform', OK_CONSOLE_SESSION_EPOCH:'test-epoch', OK_CONSOLE_AUTHORIZATION_REVISION:'mapping-1',
      OK_CONSOLE_SESSION_ENVELOPE_PRIMARY_KEY_ID:'test-key',
      OK_CONSOLE_SESSION_ENVELOPE_KEYS_FILE:await put('keys.json',JSON.stringify({ 'test-key':Buffer.alloc(32,1).toString('base64') })),
      OK_CONSOLE_POSTGRES_URL_FILE:await put('database',runtimeUrl.toString()), OK_CONSOLE_POSTGRES_ALLOW_INSECURE_LOOPBACK:'true',
      OK_CONSOLE_LOCAL_ACCESS_PEPPER_FILE:await put('pepper',Buffer.alloc(32,2).toString('base64')),
      OK_CONSOLE_LOCAL_TLS_CERT_FILE:`${directory}/cert.pem`, OK_CONSOLE_LOCAL_TLS_KEY_FILE:`${directory}/key.pem`,
      OK_CONSOLE_LOCAL_ACCESS_MODE:'bootstrap',
      OK_CONSOLE_LOCAL_ACCESS_ACCOUNTS_FILE:await put('bootstrap.json',JSON.stringify({ version:'v1', accounts:[{
        username:'named-bootstrap',enabled:true,salt:salt.toString('base64'),verifier:scryptSync(password,salt,32,{ N:32768,r:8,p:1,maxmem:67108864 }).toString('base64'),
        identityId:'named-bootstrap',displayName:'Named Bootstrap',environmentId:scope.environmentId,tenantIds:['platform'],permissions:bootstrap.permissions,
      }] })),
    }
    runtime = await createConsoleServer({ env })
    await new Promise((resolve) => runtime.server.listen(port,'127.0.0.1',resolve))
  },30000)
  beforeEach(async () => {
    await pool.query('TRUNCATE ok_console.sessions,ok_console.local_access_throttle,ok_console.local_access_audit,ok_console.authentication_audit,ok_identity.accounts,ok_identity.audit,ok_identity.login_throttle')
    await pool.query('UPDATE ok_identity.state SET initialized=false')
  })
  afterAll(async () => {
    if (runtime) { await new Promise((resolve)=>runtime.server.close(resolve)); await runtime.sessionRuntime.close() }
    await pool?.end()
    if (directory) await rm(directory,{recursive:true,force:true})
  })

  it('completes authenticated Bootstrap -> admin -> create/list -> local login -> disable -> all session paths rejected over verified HTTPS', async () => {
    const seed = client()
    await seed.request('/api/console/v0/auth/local',{ username:'named-bootstrap',password,reason:'Attended administrator initialization' })
    await seed.request('/api/console/v0/local-identity/initialize',{ username:'admin-one',password })
    await expect(seed.request('/api/console/v0/local-identity/initialize',{ username:'admin-two',password })).rejects.toThrow()
    const admin = await login('admin-one')
    const made = await admin.request('/api/console/v0/local-identity/create',{ username:'reader-one',password,consoleReader:true })
    expect((await admin.request('/api/console/v0/local-identity/list')).users).toHaveLength(2)
    const reader = await login('reader-one')
    expect((await reader.request('/api/console/v0/auth/session')).data.subject.method).toBe('Local')
    expect((await reader.request('/api/console/v0/overview')).kind).toBe('PlatformOverview')
    expect((await reader.request('/api/console/v0/session')).data.subject.assurance).toBe('Local development')
    await expect(reader.request('/api/console/v0/local-identity/list')).rejects.toThrow()
    await admin.request('/api/console/v0/local-identity/disable',{ id:made.user.id })
    await expect(login('reader-one')).rejects.toThrow()
    await expect(reader.request('/api/console/v0/auth/session')).rejects.toThrow()
    await expect(reader.request('/api/console/v0/auth/session/rotate',{})).rejects.toThrow()
    await expect(reader.request('/api/console/v0/overview')).rejects.toThrow()
    const events = (await pool.query('SELECT action FROM ok_identity.audit')).rows.map(r=>r.action)
    expect(events).toEqual(expect.arrayContaining(['Initialized','Created','Disabled','LoginDenied','LoginGranted']))
    expect(JSON.stringify((await pool.query('SELECT * FROM ok_identity.audit')).rows)).not.toContain(password)
    await admin.close(); await seed.close()
  },30000)

  it('runs the attended CLI itself for initialize/create/list/disable without echoing passwords', async () => {
    const command = (args) => new Promise((resolve, reject) => {
      const child = execFile('python3', [fileURLToPath(new URL('../fixtures/ok214_cli_pty.py', import.meta.url))], {
        env: { ...process.env, OK_CONSOLE_ORIGIN:origin, OK_CONSOLE_LOCAL_TLS_CA_FILE:`${directory}/cert.pem` }, timeout:25000,
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin.end(JSON.stringify({ node:process.execPath, cli:fileURLToPath(new URL('../cli/localIdentity.mjs',import.meta.url)),args,password }))
    })
    await command(['initialize','admin-one','--admin','named-bootstrap'])
    const created = await command(['create','cli-reader','--admin','admin-one','--console-reader'])
    expect(created).toContain('cli-reader')
    expect(await command(['list','--admin','admin-one'])).toContain('cli-reader')
    const reader = await login('cli-reader')
    const row=(await pool.query("SELECT id FROM ok_identity.accounts WHERE username='cli-reader'")).rows[0]
    await command(['disable',row.id,'--admin','admin-one'])
    await expect(reader.request('/api/console/v0/auth/session')).rejects.toThrow()
    await expect(login('cli-reader')).rejects.toThrow()
  },30000)

  it('provisions named Bootstrap material through hidden TTY input with private file permissions', async () => {
    const target=`${directory}/provisioned`
    await new Promise((resolve,reject)=>{
      const child=execFile('python3',[fileURLToPath(new URL('../fixtures/ok214_cli_pty.py',import.meta.url))],{
        env:{...process.env,OK_CONSOLE_ENVIRONMENT_ID:scope.environmentId,OK_CONSOLE_TENANT_ID:'platform'},timeout:10000,
      },(error,stdout)=>error?reject(error):resolve(stdout))
      child.stdin.end(JSON.stringify({node:process.execPath,cli:fileURLToPath(new URL('../cli/provisionLocalBootstrap.mjs',import.meta.url)),args:[target,'seed-operator'],password,
        prompts:['Named Bootstrap password (15+ characters): ','Confirm Bootstrap password: ']}))
    })
    const account=JSON.parse(await readFile(`${target}/bootstrap.json`,'utf8')).accounts[0]
    expect(account.username).toBe('seed-operator')
    expect(account.permissions).toEqual(['local.users.initialize','local.users.recover'])
    expect(JSON.stringify(account)).not.toContain(password)
    const {stat}=await import('node:fs/promises')
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(`${target}/bootstrap.json`)).mode & 0o777).toBe(0o600)
    expect((await pool.query('SELECT count(*)::int AS count FROM ok_identity.accounts')).rows[0].count).toBe(0)
  },15000)

  it('serializes concurrent first-admin initialization and never reopens it', async () => {
    const results = await Promise.allSettled([init(),init()])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    await pool.query('UPDATE ok_identity.accounts SET enabled=false')
    await expect(init()).rejects.toMatchObject({ status:409 })
  },15000)

  it('protects the last administrator under concurrent disable requests', async () => {
    await init()
    // Second administrator is a test fixture, not a new role-management API.
    await pool.query("INSERT INTO ok_identity.accounts SELECT gen_random_uuid(),'admin-two',salt,verifier,hash_profile,true,true,1,clock_timestamp() FROM ok_identity.accounts LIMIT 1")
    const context = await adminContext()
    const admins=(await pool.query('SELECT id FROM ok_identity.accounts')).rows
    const outcomes=await Promise.allSettled(admins.map(row=>identity.manage('disable',context,{id:row.id},'race')))
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int AS count FROM ok_identity.accounts WHERE administrator AND enabled')).rows[0].count).toBe(1)
  },15000)

  it('leaves no usable sessions after disable races with login and rotation across store instances', async () => {
    await init(); const admin=await adminContext()
    const made=await identity.manage('create',admin,{username:'race-reader',password,consoleReader:true},'create')
    const issued=await identity.login({username:'race-reader',password},'login')
    const other = new PostgresSessionStore({ pool,codec:sessions.codec,deploymentEpoch:'test-epoch',contextValidator:(c,db)=>identity.current(c,db) })
    const results=await Promise.allSettled([
      identity.login({username:'race-reader',password},'racing-login'),
      other.rotate(issued.cookie), identity.manage('disable',admin,{id:made.user.id},'disable'),
    ])
    expect(results[2].status).toBe('fulfilled')
    for (const result of results.slice(0,2)) if (result.status==='fulfilled' && result.value?.cookie) expect(await other.resolve(result.value.cookie)).toBeNull()
    expect(await sessions.resolve(issued.cookie)).toBeNull()
  },20000)

  it('requires admin authority, CSRF and same-origin mutations; redacts errors', async () => {
    const guest=client()
    await expect(guest.request('/api/console/v0/local-identity/list')).rejects.toThrow()
    await init(); const admin=await login('admin-one')
    admin.cookies.delete('__Host-ok_console_csrf')
    await expect(admin.request('/api/console/v0/local-identity/create',{username:'reader-one',password,consoleReader:true})).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int AS count FROM ok_identity.accounts')).rows[0].count).toBe(1)
    expect(cookieHeader(admin)).not.toContain(password)
    await expect(identity.manage('list',{...bootstrap,permissions:['local.users.admin']},{},'denied')).rejects.toMatchObject({status:403})
  },15000)

  it('starts and signs in locally when configured external OIDC discovery is unavailable', async () => {
    await init()
    await writeFile(`${directory}/oidc-secret`,'test-client-secret',{mode:0o600})
    await writeFile(`${directory}/mapping.json`,JSON.stringify({version:'v1',subjects:[{providerSubject:'external-sub',identityId:'external-id',displayName:'External',assurance:['Federated'],tenantIds:['platform'],permissions:[]}]}),{mode:0o600})
    const offline = await createSessionRuntime({ env:{...env,OK_CONSOLE_LOCAL_ACCESS_MODE:'disabled',OK_CONSOLE_OIDC_ENABLED:'true',OK_CONSOLE_OIDC_ISSUER:'https://unavailable.invalid/',OK_CONSOLE_OIDC_PROVIDER_ID:'external',OK_CONSOLE_OIDC_CLIENT_ID:'test-client',OK_CONSOLE_OIDC_CLIENT_SECRET_FILE:`${directory}/oidc-secret`,OK_CONSOLE_OIDC_SUBJECT_MAPPINGS_FILE:`${directory}/mapping.json`}, oidcProtocolFactory:async()=>{throw new Error('Provider unavailable')} })
    try {
      expect(await offline.ready()).toBe(true)
      expect(await offline.sessionStore.resolve((await identity.login({username:'admin-one',password},'local')).cookie)).not.toBeNull()
      expect(offline.localIdentityHandler).toBeTypeOf('function')
      let code
      expect(await offline.oidcHandler({pathname:'/api/console/v0/auth/oidc/start',response:{writeHead:(status)=>{code=status},end:()=>{}}})).toBe(true)
      expect(code).toBe(503)
    } finally { await offline.close() }
  },15000)

  it('rolls back account changes and session issuance when audit insertion fails', async () => {
    await init(); const admin=await adminContext()
    const target=await identity.manage('create',admin,{username:'audit-reader',password,consoleReader:true},'create')
    await pool.query("CREATE OR REPLACE FUNCTION ok_identity.reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$")
    await pool.query('CREATE TRIGGER reject_audit BEFORE INSERT ON ok_identity.audit FOR EACH ROW EXECUTE FUNCTION ok_identity.reject_audit()')
    try {
      const before=(await pool.query('SELECT count(*)::int AS count FROM ok_console.sessions')).rows[0].count
      await expect(identity.manage('create',admin,{username:'not-created',password,consoleReader:true},'create')).rejects.toMatchObject({status:503})
      await expect(identity.login({username:'admin-one',password},'login')).rejects.toMatchObject({status:503})
      expect((await pool.query('SELECT count(*)::int AS count FROM ok_identity.accounts')).rows[0].count).toBe(2)
      await expect(identity.manage('disable',admin,{id:target.user.id},'disable')).rejects.toMatchObject({status:503})
      expect((await pool.query('SELECT enabled FROM ok_identity.accounts WHERE id=$1',[target.user.id])).rows[0].enabled).toBe(true)
      expect((await pool.query('SELECT count(*)::int AS count FROM ok_console.sessions')).rows[0].count).toBe(before)
      await expect(identity.manage('disable',admin,{id:admin.subject.id},'disable')).rejects.toBeDefined()
    } finally {
      await pool.query('DROP TRIGGER reject_audit ON ok_identity.audit')
      await pool.query('DROP FUNCTION ok_identity.reject_audit()')
    }
  },15000)

  it('applies durable ordinary throttling across instances without blocking exceptional access', async () => {
    for(let i=0;i<5;i++) await expect(identity.login({username:'unknown-user',password},'denied')).rejects.toBeDefined()
    const throttle=new PostgresLocalAccessThrottle({pool:ordinaryThrottlePool(pool),pepper:Buffer.alloc(32,2)})
    expect(await throttle.blocked('ordinary:unknown-user')).toBe(true)
    expect(await new PostgresLocalAccessThrottle({pool,pepper:Buffer.alloc(32,2)}).blocked('named-bootstrap')).toBe(false)
    expect(JSON.stringify((await pool.query('SELECT * FROM ok_identity.login_throttle')).rows)).not.toContain('unknown-user')
  },15000)

  it('fails closed when identity, session or throttle tables are unavailable', async () => {
    await init(); const admin=await login('admin-one')
    for (const [schema,table,path,body] of [
      ['ok_identity','accounts','/api/console/v0/auth/session',undefined],
      ['ok_console','sessions','/api/console/v0/auth/session',undefined],
      ['ok_identity','login_throttle','/api/console/v0/local-identity/login',{username:'admin-one',password}],
    ]) {
      await pool.query(`ALTER TABLE ${schema}.${table} RENAME TO unavailable_table`)
      try { await expect(admin.request(path,body)).rejects.toThrow() }
      finally { await pool.query(`ALTER TABLE ${schema}.unavailable_table RENAME TO ${table}`) }
    }
    await admin.close()
  },15000)

  it('runs the HTTP lifecycle with a non-owner runtime role that cannot edit audit history or own schemas', async () => {
    const database=new URL(await readFile(env.OK_CONSOLE_POSTGRES_URL_FILE,'utf8'))
    const restricted=new pg.Pool({connectionString:database.toString()})
    try {
      await expect(restricted.query('DELETE FROM ok_identity.audit')).rejects.toMatchObject({code:'42501'})
      await expect(restricted.query('CREATE TABLE ok_identity.bypass(id int)')).rejects.toMatchObject({code:'42501'})
      await expect(restricted.query('ALTER TABLE ok_console.sessions ADD COLUMN bypass int')).rejects.toMatchObject({code:'42501'})
    } finally { await restricted.end() }
  })

  it.runIf(process.env.OK_CONSOLE_TEST_LOCAL_BROWSER === 'true')('signs an ordinary user into the actual Console and rejects session reuse after disable', async () => {
    await init(); const admin=await adminContext()
    const created=await identity.manage('create',admin,{username:'browser-reader',password,consoleReader:true},'create')
    const {chromium}=await import('@playwright/test')
    const browser=await chromium.launch({headless:true})
    try {
      // Test-only CA bypass for Chromium; CLI/API acceptance above verifies the actual CA.
      const context=await browser.newContext({ignoreHTTPSErrors:true})
      const page=await context.newPage()
      await page.goto(origin)
      await page.getByLabel('Username',{exact:true}).fill('browser-reader')
      await page.getByLabel('Password',{exact:true}).fill(password)
      await page.getByRole('button',{name:'Sign in',exact:true}).click()
      await page.getByRole('button',{name:'Sign out of OpenKubes Console',exact:true}).waitFor({timeout:10000})
      expect(await page.evaluate(()=>({local:globalThis.localStorage.length,session:globalThis.sessionStorage.length}))).toEqual({local:0,session:0})
      await page.screenshot({path:'/tmp/ok214-console-local-login.png',fullPage:true})
      await identity.manage('disable',admin,{id:created.user.id},'disable')
      const status=await page.evaluate(async()=> (await fetch('/api/console/v0/auth/session')).status)
      expect(status).toBe(401)
      await page.reload()
      await page.getByRole('button',{name:'Sign in',exact:true}).waitFor({timeout:10000})
    } finally { await browser.close() }
  },30000)

  it('recovers an existing named admin through separately authorized Bootstrap without reopening initialization', async () => {
    await init(); const issued=await identity.login({username:'admin-one',password},'login')
    await expect(identity.manage('recover',{...bootstrap,permissions:[]},{username:'admin-one',password},'denied')).rejects.toMatchObject({status:403})
    await identity.manage('recover',bootstrap,{username:'admin-one',password},'recover')
    expect(await sessions.resolve(issued.cookie)).toBeNull()
    expect((await identity.login({username:'admin-one',password},'login')).session.data.subject.method).toBe('Local')
    await expect(init()).rejects.toMatchObject({status:409})
  },15000)
})
