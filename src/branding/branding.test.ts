import Ajv2020 from 'ajv/dist/2020'
import exampleJson from './test-fixtures/example/branding.json'
import { describe, expect, it } from 'vitest'
import { contrastRatio, deriveTokens, validateBranding } from '../../bff/branding.mjs'
import schema from '../../contracts/branding/v1/branding.schema.json'
import { DEFAULT_DEPLOYMENT_POLICY, READ_ONLY_UNKNOWN } from '../deploymentPolicy'
import { readInstallation } from '../installation'
import { applyBrandingToDocument, applyNeutralDocument, brandingFailed, DEFAULT_BRANDING, resolveBrandingValue } from './branding'

const example: Record<string, unknown> = structuredClone(exampleJson)

const ajv = new Ajv2020({ allErrors: true, strict: false })
const schemaValid = ajv.compile(schema)

const variant = (patch: Record<string, unknown>) => ({ ...structuredClone(example), ...patch })

const invalidCases: [string, Record<string, unknown>, RegExp][] = [
  ['wrong schema id', variant({ schema: 'acme.branding/v9' }), /^schema:/],
  ['unknown top-level field', variant({ theme: { radius: 4 } }), /theme: unknown field/],
  ['asset with a path', variant({ logo: { file: '../secrets/logo.svg', alt: 'x' } }), /logo.file/],
  ['remote asset URL', variant({ favicon: 'https://cdn.example.com/f.png' }), /favicon/],
  ['unsupported asset type', variant({ favicon: 'mark.gif' }), /favicon/],
  ['colour not #rrggbb', variant({ colors: { primary: 'blue', accent: '#ffd166' } }), /colors.primary/],
  ['primary too light for white text', variant({ colors: { primary: '#87ceeb', accent: '#ffd166' } }), /colors.primary: white text/],
  ['accent too dark for the login panel', variant({ colors: { primary: '#5b2a86', accent: '#3a2a50' } }), /colors.accent: needs a contrast/],
  ['product name too long', variant({ productName: 'x'.repeat(41) }), /productName: at most 40/],
  ['control characters', variant({ productName: 'Acme\u0007Ops' }), /control characters/],
  ['too many headline lines', variant({ login: { headline: ['a', 'b', 'c', 'd', 'e'] } }), /login.headline/],
  ['unknown login field', variant({ login: { html: '<b>x</b>' } }), /login.html: unknown field/],
  ['empty powered-by name', variant({ poweredBy: { name: ' ' } }), /poweredBy.name: must not be empty/],
]

describe('branding validator (shared by BFF and Console)', () => {
  it('accepts the synthetic example brand', () => {
    const result = validateBranding(example)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it.each(invalidCases)('rejects %s', (_name, input, message) => {
    const result = validateBranding(input)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toMatch(message)
  })

  it('agrees with the published JSON schema on structure', () => {
    expect(schemaValid(example)).toBe(true)
    const structural = invalidCases.filter(([name]) => !name.includes('too light') && !name.includes('too dark'))
    for (const [name, input] of structural) expect(schemaValid(input), name).toBe(false)
  })

  it('computes WCAG contrast and derives a fixed token set from two colours', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    const tokens = deriveTokens({ primary: '#1355b9', accent: '#1ee9e3' })
    expect(Object.keys(tokens).sort()).toEqual(['--accent', '--blue', '--blue-dark', '--blue-soft', '--brand-bright', '--brand-deep', '--brand-emphasis', '--brand-kicker', '--brand-on-deep', '--brand-on-deep-faint', '--brand-panel'])
    expect(tokens['--blue']).toBe('#1355b9')
    expect(tokens['--brand-deep']).toBe('#061a38')
  })
})

const installationHtml = (installation: unknown) => {
  document.head.innerHTML = '<meta name="theme-color" content="#064fc8"><meta name="description" content="OpenKubes"><link rel="icon" type="image/png" href="./openkubes-icon.png">'
  document.body.innerHTML = '<div id="root"></div>'
  if (installation !== undefined) {
    const element = document.createElement('script')
    element.type = 'application/json'
    element.id = 'ok-console-installation'
    element.textContent = typeof installation === 'string' ? installation : JSON.stringify(installation)
    document.head.append(element)
  }
}
const policyDefault = { schema: 'openkubes.console.deployment-policy/v1', policy: 'default', clusterLifecycle: true }
const policyReadOnly = { schema: 'openkubes.console.deployment-policy/v1', policy: 'fixture-read-only', clusterLifecycle: false }
const installation = (branding: unknown, deploymentPolicy: unknown = policyDefault) => ({ schema: 'openkubes.console.installation/v1', branding, deploymentPolicy })

describe('installation data read by the Console', () => {
  it('keeps built-in behaviour without a data block (static hosting without the BFF)', () => {
    installationHtml(undefined)
    expect(readInstallation()).toEqual({ branding: { branding: DEFAULT_BRANDING, status: 'absent', errors: [] }, policy: DEFAULT_DEPLOYMENT_POLICY })
  })

  it('uses the built-in default when no branding is configured', () => {
    installationHtml(installation(null))
    expect(readInstallation()).toEqual({ branding: { branding: DEFAULT_BRANDING, status: 'absent', errors: [] }, policy: DEFAULT_DEPLOYMENT_POLICY })
  })

  it('resolves a valid brand to same-origin asset URLs and derived tokens, independently of the policy', () => {
    installationHtml(installation(example, policyReadOnly))
    const { branding: { branding, status }, policy } = readInstallation()
    expect(status).toBe('configured')
    expect(branding).toMatchObject({ productName: 'Example Ops Console', productShortName: 'Example Ops', logoUrl: './branding/example-mark.svg', faviconUrl: './branding/example-mark.svg', poweredBy: 'Example Platform' })
    expect(branding.tokens?.['--accent']).toBe('#ffd166')
    expect(policy).toEqual({ policy: 'fixture-read-only', clusterLifecycleAvailable: false })
  })

  it('fails closed for an invalid brand, reported problems and unreadable data', () => {
    installationHtml(installation(variant({ favicon: '../x.svg' })))
    const invalid = readInstallation()
    expect(invalid.branding.status).toBe('invalid')
    expect(invalid.branding.errors.join()).toMatch(/favicon/)
    expect(brandingFailed(invalid.branding.status)).toBe(true)

    installationHtml(installation({ errors: ['colors.primary: too light'] }))
    expect(readInstallation().branding).toEqual({ branding: DEFAULT_BRANDING, status: 'invalid', errors: ['colors.primary: too light'] })

    for (const broken of ['{', JSON.stringify({ schema: 'other', branding: null })]) {
      installationHtml(broken)
      expect(readInstallation()).toEqual({ branding: { branding: DEFAULT_BRANDING, status: 'invalid', errors: ['installation data unreadable'] }, policy: READ_ONLY_UNKNOWN })
    }
  })

  it('neutralizes the document for a failed configured brand', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#064fc8"><meta name="description" content="OpenKubes"><link rel="icon" href="./openkubes-icon.png">'
    applyNeutralDocument()
    expect(document.title).toBe('Console unavailable')
    expect(document.head.innerHTML).not.toMatch(/OpenKubes|openkubes-icon|#064fc8/)
  })

  it('applies a configured brand to the document and leaves the default untouched', async () => {
    document.head.innerHTML = '<meta name="theme-color" content="#064fc8"><meta name="description" content="x"><link rel="icon" type="image/png" href="./openkubes-icon.png">'
    document.title = 'OpenKubes Console'
    applyBrandingToDocument(DEFAULT_BRANDING)
    expect(document.documentElement.style.getPropertyValue('--blue')).toBe('')
    expect(document.title).toBe('OpenKubes Console')

    const { branding } = resolveBrandingValue(example)
    applyBrandingToDocument(branding)
    expect(document.documentElement.style.getPropertyValue('--blue')).toBe('#5b2a86')
    expect(document.documentElement.dataset.brand).toBe('configured')
    expect(document.querySelector('link[rel="icon"]')).toHaveAttribute('href', './branding/example-mark.svg')
    expect(document.querySelector('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#5b2a86')
    expect(document.title).toBe('Example Ops Console')
  })
})
